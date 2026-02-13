from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import urlparse

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError
from GameSentenceMiner.ai.features.character_context import CharacterContextProvider
from GameSentenceMiner.ai.features.character_summary import CharacterSummaryService
from GameSentenceMiner.ai.parsing.output_parser import OutputParser
from GameSentenceMiner.ai.prompts.builder import PromptBuilder
from GameSentenceMiner.ai.registry import ProviderRegistry
from GameSentenceMiner.util.config.configuration import AI_GEMINI, AI_GROQ, AI_GSM_CLOUD, AI_LM_STUDIO, AI_OLLAMA, AI_OPENAI, Ai, \
    General
from GameSentenceMiner.util.gsm_utils import is_connected
from GameSentenceMiner.util.text_log import GameLine


@dataclass(frozen=True)
class AIConfigSnapshot:
    ai: Ai
    general: General


def snapshot_config(ai_config: Ai, general_config: General) -> AIConfigSnapshot:
    return AIConfigSnapshot(ai=copy.deepcopy(ai_config), general=copy.deepcopy(general_config))


def _is_local_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    host = parsed.hostname or ""
    host = host.lower()
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _requires_internet(config: Ai) -> bool:
    if config.provider in {AI_GEMINI, AI_GROQ, AI_GSM_CLOUD}:
        return True
    if config.provider == AI_OPENAI:
        return not _is_local_url(config.open_ai_url)
    if config.provider == AI_LM_STUDIO:
        return False
    if config.provider == AI_OLLAMA:
        return False
    return True


class AIService:
    def __init__(
        self,
        config_snapshot: AIConfigSnapshot,
        logger,
        registry: Optional[ProviderRegistry] = None,
        output_parser: Optional[OutputParser] = None,
    ):
        self.config_snapshot = config_snapshot
        self.logger = logger or logging.getLogger(__name__)
        self.registry = registry or ProviderRegistry(logger)
        self.output_parser = output_parser or OutputParser(compat_mode=True)
        self.prompt_builder = PromptBuilder(
            native_language_name=config_snapshot.general.get_native_language_name()
        )
        self.character_summary_service = CharacterSummaryService(logger)
        self.character_context_provider = CharacterContextProvider(
            summary_service=self.character_summary_service,
            logger=logger,
        )

    def _make_request(self, prompt: str, request_kind: str) -> AIRequest:
        ai_cfg = self.config_snapshot.ai
        provider = ai_cfg.provider
        model = self._get_model_for_provider(ai_cfg)
        return AIRequest(
            provider=provider,
            model=model,
            prompt=prompt,
            temperature=ai_cfg.temperature,
            top_p=ai_cfg.top_p,
            max_tokens=ai_cfg.max_output_tokens,
            request_kind=request_kind,
        )

    @staticmethod
    def _get_model_for_provider(config: Ai) -> str:
        if config.provider == AI_GEMINI:
            return config.gemini_model
        if config.provider == AI_GROQ:
            return config.groq_model
        if config.provider == AI_GSM_CLOUD:
            return config.get_gsm_cloud_primary_model()
        if config.provider == AI_OPENAI:
            return config.open_ai_model
        if config.provider == AI_OLLAMA:
            return config.ollama_model
        if config.provider == AI_LM_STUDIO:
            return config.lm_studio_model
        return ""

    @staticmethod
    def _get_backup_model_for_provider(config: Ai) -> str:
        if config.provider == AI_GEMINI:
            return config.gemini_backup_model
        if config.provider == AI_GROQ:
            return config.groq_backup_model
        if config.provider == AI_OPENAI:
            return config.open_ai_backup_model
        if config.provider == AI_OLLAMA:
            return config.ollama_backup_model
        if config.provider == AI_LM_STUDIO:
            return config.lm_studio_backup_model
        return ""

    def _ensure_connectivity(self) -> bool:
        if _requires_internet(self.config_snapshot.ai) and not is_connected():
            self.logger.error("No internet connection. Unable to proceed with AI prompt.")
            return False
        return True

    def _execute_request(self, request: AIRequest) -> AIResponse:
        client = self.registry.get_client(self.config_snapshot.ai)
        try:
            response = client.generate(request)
            parsed_text = self.output_parser.parse(response.raw_text)
            return AIResponse(
                provider=response.provider,
                model=response.model,
                text=parsed_text,
                raw_text=response.raw_text,
                latency_ms=response.latency_ms,
                usage=response.usage,
            )
        except AIError as primary_error:
            backup_model = self._get_backup_model_for_provider(self.config_snapshot.ai)
            if not backup_model or backup_model == request.model:
                raise

            self.logger.warning(
                "Primary AI model failed (%s). Retrying with backup model '%s'.",
                request.model,
                backup_model,
            )
            backup_request = AIRequest(
                provider=request.provider,
                model=backup_model,
                prompt=request.prompt,
                temperature=request.temperature,
                top_p=request.top_p,
                max_tokens=request.max_tokens,
                game_title=request.game_title,
                request_kind=request.request_kind,
                metadata=request.metadata,
            )
            try:
                response = client.generate(backup_request)
                parsed_text = self.output_parser.parse(response.raw_text)
                return AIResponse(
                    provider=response.provider,
                    model=response.model,
                    text=parsed_text,
                    raw_text=response.raw_text,
                    latency_ms=response.latency_ms,
                    usage=response.usage,
                )
            except AIError as backup_error:
                self.logger.error(
                    "Backup AI model '%s' also failed after primary model '%s': %s",
                    backup_model,
                    request.model,
                    backup_error,
                )
                raise primary_error

    def translate(
        self,
        lines: List[GameLine],
        sentence: str,
        current_line: GameLine,
        game_title: str = "",
        custom_prompt: Optional[str] = None,
    ) -> str:
        if not lines or not current_line:
            self.logger.warning(
                f"Invalid input for process: lines={len(lines)}, current_line={getattr(current_line, 'index', None)}"
            )
            return "Invalid input."

        if not self._ensure_connectivity():
            return ""

        character_context = self.character_context_provider.get_character_context(
            game_title=game_title,
            ai_service=self,
        )

        full_prompt, prompt_kind = self.prompt_builder.build(
            lines=lines,
            sentence=sentence,
            current_line=current_line,
            game_title=game_title,
            dialogue_context_length=self.config_snapshot.ai.dialogue_context_length,
            use_canned_translation_prompt=self.config_snapshot.ai.use_canned_translation_prompt,
            use_canned_context_prompt=self.config_snapshot.ai.use_canned_context_prompt,
            custom_prompt=self.config_snapshot.ai.custom_prompt,
            custom_prompt_override=custom_prompt,
            character_context=character_context,
        )

        request = self._make_request(full_prompt, request_kind=prompt_kind)
        try:
            response = self._execute_request(request)
            return response.text
        except AIError as e:
            self.logger.error(f"AI processing failed: {e}")
            return f"Processing failed: {e}"

    def generate_raw_prompt(self, prompt: str, request_kind: str = "raw") -> str:
        if not self._ensure_connectivity():
            return ""

        request = self._make_request(prompt, request_kind=request_kind)
        try:
            response = self._execute_request(request)
            return response.text
        except AIError as e:
            self.logger.error(f"AI processing failed: {e}")
            return f"Processing failed: {e}"
