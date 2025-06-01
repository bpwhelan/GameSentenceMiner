import logging
import textwrap
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

import google.generativeai as genai
from google.generativeai import GenerationConfig
from groq import Groq

from GameSentenceMiner.util.configuration import get_config, Ai, logger
from GameSentenceMiner.util.gsm_utils import is_connected
from GameSentenceMiner.util.text_log import GameLine

# Suppress debug logs from httpcore
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("groq._base_client").setLevel(logging.WARNING)


TRANSLATION_PROMPT = textwrap.dedent(f"""Translate the following Japanese dialogue from this game into natural, context-aware English. Focus on preserving the tone, intent, and emotional nuance of the original text, paying close attention to the context provided by surrounding lines. The dialogue may include slang, idioms, implied meanings, or game-specific terminology that should be adapted naturally for English-speaking players. Ensure the translation feels immersive and aligns with the game's narrative style and character voices.
                                    Translate only the specified line below, providing a single result. Do not include additional text, explanations, alternatives, or other lines unless explicitly requested. If there are alternatives, choose the best one. Allow expletives if more natural. Allow HTML tags for emphasis, italics, and other formatting as needed. Please also try to preserve existing HTML tags from the specified sentence if appropriate. Answer with nothing but the best translation, no alternatives or explanations.

                                    Line to Translate:
""")

CONTEXT_PROMPT = textwrap.dedent(f"""Provide a very brief summary of the scene in English based on the provided Japanese dialogue and context. Focus on the characters' actions and the immediate situation being described.

                                    Current Sentence:
""")

class AIType(Enum):
    GEMINI = "Gemini"
    GROQ = "Groq"

@dataclass
class AIConfig:
    api_key: str
    model: str
    api_url: Optional[str]
    type: 'AIType'

@dataclass
class GeminiAIConfig(AIConfig):
    def __init__(self, api_key: str, model: str = "gemini-2.0-flash"):
        super().__init__(api_key=api_key, model=model, api_url=None, type=AIType.GEMINI)

@dataclass
class GroqAiConfig(AIConfig):
    def __init__(self, api_key: str, model: str = "meta-llama/llama-4-scout-17b-16e-instruct"):
        super().__init__(api_key=api_key, model=model, api_url=None, type=AIType.GROQ)


class AIManager(ABC):
    def __init__(self, ai_config: AIConfig, logger: Optional[logging.Logger] = None):
        self.ai_config = ai_config
        self.logger = logger

    @abstractmethod
    def process(self, lines: List[GameLine], sentence: str, current_line_index: int, game_title: str = "") -> str:
        pass

    @abstractmethod
    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        start_index = max(0, current_line.index - 10)
        end_index = min(len(lines), current_line.index + 11)

        context_lines_text = []
        for i in range(start_index, end_index):
            if i < len(lines):
                context_lines_text.append(lines[i].text)

        dialogue_context = "\n".join(context_lines_text)

        if get_config().ai.use_canned_translation_prompt:
            prompt_to_use = TRANSLATION_PROMPT
        elif get_config().ai.use_canned_context_prompt:
            prompt_to_use = CONTEXT_PROMPT
        else:
            prompt_to_use = getattr(self.ai_config, 'custom_prompt', "")

        full_prompt = textwrap.dedent(f"""
            Dialogue Context:

            {dialogue_context}

            I am playing the game {game_title}. With that, and the above dialogue context in mind, answer the following prompt.

            {prompt_to_use}

            {sentence}
        """)
        return full_prompt


class GeminiAI(AIManager):
    def __init__(self, model, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(GeminiAIConfig(model=model, api_key=api_key), logger)
        try:
            genai.configure(api_key=self.ai_config.api_key)
            model_name = self.ai_config.model
            self.model = genai.GenerativeModel(model_name,
                                               generation_config=GenerationConfig(
                                                   temperature=0.5,
                                                   max_output_tokens=1024,
                                                   top_p=1,
                                                   stop_sequences=None,
                                               )
                                               )
            self.logger.debug(f"GeminiAIManager initialized with model: {model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")
            self.model = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line, game_title)
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "") -> str:
        if self.model is None:
            return "Processing failed: AI model not initialized."

        if not lines or not current_line:
            self.logger.warning(f"Invalid input for process: lines={len(lines)}, current_line={current_line.index}")
            return "Invalid input."

        try:
            prompt = self._build_prompt(lines, sentence, current_line, game_title)
            self.logger.debug(f"Generated prompt:\n{prompt}")
            response = self.model.generate_content(prompt)
            result = response.text.strip()
            self.logger.debug(f"Received response:\n{result}")
            return result
        except Exception as e:
            self.logger.error(f"Gemini processing failed: {e}")
            return f"Processing failed: {e}"

class GroqAI(AIManager):
    def __init__(self, model, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(GroqAiConfig(model=model, api_key=api_key), logger)
        self.api_key = self.ai_config.api_key
        self.model_name = self.ai_config.model
        try:
            self.client = Groq(api_key=self.api_key)
            self.logger.debug(f"GroqAIManager initialized with model: {self.model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize Groq client: {e}")
            self.client = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line, game_title)
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "") -> str:
        if self.client is None:
            return "Processing failed: Groq client not initialized."

        if not lines or not current_line:
            self.logger.warning(f"Invalid input for process: lines={len(lines)}, current_line={current_line.index}")
            return "Invalid input."

        try:
            prompt = self._build_prompt(lines, sentence, current_line, game_title)
            self.logger.debug(f"Generated prompt:\n{prompt}")
            completion = self.client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=.5,
                max_completion_tokens=1024,
                top_p=1,
                stream=False,
                stop=None,
            )
            result = completion.choices[0].message.content.strip()
            self.logger.debug(f"Received response:\n{result}")
            return result
        except Exception as e:
            self.logger.error(f"Groq processing failed: {e}")
            return f"Processing failed: {e}"

ai_manager: AIManager | None = None
current_ai_config: Ai | None = None

def get_ai_prompt_result(lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = ""):
    global ai_manager, current_ai_config
    try:
        if not is_connected():
            logger.error("No internet connection. Unable to proceed with AI prompt.")
            return ""
        if not ai_manager or get_config().ai != current_ai_config:
            if get_config().ai.provider == AIType.GEMINI.value:
                ai_manager = GeminiAI(model=get_config().ai.gemini_model, api_key=get_config().ai.gemini_api_key, logger=logger)
            elif get_config().ai.provider == AIType.GROQ.value:
                ai_manager = GroqAI(model=get_config().ai.groq_model, api_key=get_config().ai.groq_api_key, logger=logger)
            current_ai_config = get_config().ai
        if not ai_manager:
            logger.error("AI is enabled but the AI Manager did not initialize. Check your AI Config IN GSM.")
            return ""
        return ai_manager.process(lines, sentence, current_line, game_title)
    except Exception as e:
        logger.error("Error caught while trying to get AI prompt result. Check logs for more details.")
        logger.debug(e)
        return ""

if __name__ == '__main__':
    lines = [
        GameLine(index=0, text="こんにちは、元気ですか？", id=None, time=None, prev=None, next=None),
        GameLine(index=1, text="今日はいい天気ですね。",id=None, time=None, prev=None, next=None),
        GameLine(index=2, text="ゲームを始めましょう！",id=None, time=None, prev=None, next=None),
    ]
    sentence = "ゲームを始めましょう！"
    current_line = lines[2]
    game_title = "Test Game"

    # Set up logging
    logging.basicConfig(level=logging.DEBUG)

    # Test the function
    result = get_ai_prompt_result(lines, sentence, current_line, game_title)
    print("AI Prompt Result:", result)