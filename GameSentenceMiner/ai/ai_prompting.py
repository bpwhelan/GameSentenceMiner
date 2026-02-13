import logging
from typing import List, Optional

from GameSentenceMiner.ai.features.character_summary import CharacterSummaryService
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import (
    AI_GEMINI,
    AI_GROQ,
    AI_GSM_CLOUD,
    AI_LM_STUDIO,
    AI_OLLAMA,
    AI_OPENAI,
    Ai,
    get_config,
    logger,
)
from GameSentenceMiner.util.text_log import GameLine

# Suppress debug logs from httpcore
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("groq._base_client").setLevel(logging.WARNING)


def get_ai_prompt_result(
    lines: List[GameLine],
    sentence: str,
    current_line: GameLine,
    game_title: str = "",
    force_refresh: bool = False,
    custom_prompt=None,
) -> str:
    try:
        config = get_config()
        snapshot = snapshot_config(config.ai, config.general)
        service = AIService(config_snapshot=snapshot, logger=logger)
        return service.translate(
            lines=lines,
            sentence=sentence,
            current_line=current_line,
            game_title=game_title,
            custom_prompt=custom_prompt,
        )
    except Exception as e:
        logger.error(
            "Error caught while trying to get AI prompt result. Check logs for more details.",
            exc_info=True,
        )
        logger.debug(e, exc_info=True)
        return ""


def ai_config_changed(config: Ai, current: Optional[Ai]) -> bool:
    if not current:
        return True
    if config.provider != current.provider:
        return True
    if config.provider == AI_GEMINI and (
        config.gemini_api_key != current.gemini_api_key
        or config.gemini_model != current.gemini_model
        or config.gemini_backup_model != current.gemini_backup_model
    ):
        return True
    if config.provider == AI_GROQ and (
        config.groq_api_key != current.groq_api_key
        or config.groq_model != current.groq_model
        or config.groq_backup_model != current.groq_backup_model
    ):
        return True
    if config.provider == AI_OPENAI and (
        config.open_ai_api_key != current.open_ai_api_key
        or config.open_ai_model != current.open_ai_model
        or config.open_ai_backup_model != current.open_ai_backup_model
        or config.open_ai_url != current.open_ai_url
    ):
        return True
    if config.provider == AI_GSM_CLOUD and (
        config.gsm_cloud_access_token != current.gsm_cloud_access_token
        or config.gsm_cloud_models != current.gsm_cloud_models
        or config.gsm_cloud_api_url != current.gsm_cloud_api_url
    ):
        return True
    if config.provider == AI_OLLAMA and (
        config.ollama_url != current.ollama_url
        or config.ollama_model != current.ollama_model
        or config.ollama_backup_model != current.ollama_backup_model
    ):
        return True
    if config.provider == AI_LM_STUDIO and (
        config.lm_studio_url != current.lm_studio_url
        or config.lm_studio_model != current.lm_studio_model
        or config.lm_studio_backup_model != current.lm_studio_backup_model
        or config.lm_studio_api_key != current.lm_studio_api_key
    ):
        return True
    if config.custom_prompt != current.custom_prompt:
        return True
    if config.custom_full_prompt != current.custom_full_prompt:
        return True
    if config.use_canned_translation_prompt != current.use_canned_translation_prompt:
        return True
    if config.use_canned_context_prompt != current.use_canned_context_prompt:
        return True
    if config.temperature != current.temperature:
        return True
    if config.max_output_tokens != current.max_output_tokens:
        return True
    if config.top_p != current.top_p:
        return True
    return False


def generate_character_summary(character_data: dict) -> Optional[str]:
    if not character_data:
        return None

    config = get_config()
    snapshot = snapshot_config(config.ai, config.general)
    service = AIService(config_snapshot=snapshot, logger=logger)
    summary_service = CharacterSummaryService(logger=logger)
    return summary_service.generate_from_vndb(character_data, service)
