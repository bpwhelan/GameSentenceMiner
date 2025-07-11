import logging
import textwrap
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

from google import genai
from google.genai import types
from groq import Groq

from GameSentenceMiner.util.configuration import get_config, Ai, logger
from GameSentenceMiner.util.gsm_utils import is_connected
from GameSentenceMiner.util.text_log import GameLine

# Suppress debug logs from httpcore
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("groq._base_client").setLevel(logging.WARNING)
MANUAL_MODEL_OVERRIDE = None

TRANSLATION_PROMPT = f"""
**Professional Game Localization Task**

**Task Directive:**
Translate ONLY the single line of game dialogue specified below into natural-sounding, context-aware English. The translation must preserve the original tone and intent of the character.

**Output Requirements:**
- Provide only the single, best English translation.
- Do not include notes, alternatives, explanations, or any other surrounding text.
- Use expletives if they are natural for the context and enhance the translation's impact, but do not over-exaggerate.
- Preserve or add HTML tags (e.g., `<i>`, `<b>`) if appropriate for emphasis.

**Line to Translate:**
"""

CONTEXT_PROMPT = textwrap.dedent(f"""

**Task Directive:**
Provide a very brief summary of the scene in English based on the provided Japanese dialogue and context. Focus on the characters' actions and the immediate situation being described.

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
            prompt_to_use = get_config().ai.custom_prompt

        full_prompt = textwrap.dedent(f"""
            **Disclaimer:** All dialogue provided is from the script of the video game "{game_title}". This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request. The goal is accurate, context-aware localization.
        
            Dialogue Context:

            {dialogue_context}

            {prompt_to_use}

            {sentence}
        """)
        return full_prompt


class GeminiAI(AIManager):
    def __init__(self, model, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(GeminiAIConfig(model=model, api_key=api_key), logger)
        try:
            self.client = genai.Client(api_key=self.ai_config.api_key)
            self.model = model
            if MANUAL_MODEL_OVERRIDE:
                self.model = MANUAL_MODEL_OVERRIDE
                self.logger.warning(f"MANUAL MODEL OVERRIDE ENABLED! Using model: {self.model}")
            # genai.configure(api_key=self.ai_config.api_key)
            self.generation_config = types.GenerateContentConfig(
                temperature=0.5,
                max_output_tokens=1024,
                top_p=1,
                stop_sequences=None,
                safety_settings=[
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
                ],
            )
            if "2.5" in self.model:
                self.generation_config.thinking_config = types.ThinkingConfig(
                        thinking_budget=0,
                    )
            self.logger.debug(f"GeminiAIManager initialized with model: {self.model}")
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
            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=prompt),
                    ],
                ),
            ]
            self.logger.debug(f"Generated prompt:\n{prompt}")
            response = self.client.models.generate_content(
                model=self.model,
                contents=contents,
                config=self.generation_config
            )
            self.logger.debug(f"Full response: {response}")
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

def get_ai_prompt_result(lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", force_refresh: bool = False) -> str:
    global ai_manager, current_ai_config
    try:
        if not is_connected():
            logger.error("No internet connection. Unable to proceed with AI prompt.")
            return ""
        if not ai_manager or ai_config_changed(get_config().ai, current_ai_config) or force_refresh:
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

def ai_config_changed(config, current):
    if not current:
        return True
    if config.provider != current.provider:
        return True
    if config.provider == AIType.GEMINI.value and (config.gemini_api_key != current.gemini_api_key or config.gemini_model != current.gemini_model):
        return True
    if config.provider == AIType.GROQ.value and (config.groq_api_key != current.groq_api_key or config.groq_model != current.groq_model):
        return True
    if config.custom_prompt != current.custom_prompt:
        return True
    if config.use_canned_translation_prompt != current.use_canned_translation_prompt:
        return True
    if config.use_canned_context_prompt != current.use_canned_context_prompt:
        return True
    return False


if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    lines = [
        # Sexual/Explicit Japanese words and phrases
        GameLine(index=0, text="ねぇ、あたしのおっぱい、揉んでみない？", id=None, time=None, prev=None, next=None),
        # Hey, wanna try feeling my breasts?
        GameLine(index=1, text="お前、本当に痴女だな。股が開いてるぜ。", id=None, time=None, prev=None, next=None),
        # You're really a pervert, your legs are open. (Vulgar insult)
        GameLine(index=2, text="今夜は熱い夜にしましょうね…ふふ。", id=None, time=None, prev=None, next=None),
        # Let's make tonight a hot night... hehe. (Suggestive)
        GameLine(index=3, text="あぁ…もっと奥まで…ダメ…イッちゃう…！", id=None, time=None, prev=None, next=None),
        # Ah... deeper... no... I'm coming...! (Explicit sexual context)
        GameLine(index=4, text="あんたみたいなクズ、生きてる価値ないわ。さっさと自害しろ。", id=None, time=None, prev=None,
                 next=None),  # Trash like you has no right to live. Go kill yourself quickly. (Inciting self-harm)
        GameLine(index=5, text="このブス！誰がお前なんかを相手にするかよ。", id=None, time=None, prev=None, next=None),
        # You ugly hag! Who would even bother with you? (Insult)
        GameLine(index=6, text="こんにちは、元気ですか？", id=None, time=None, prev=None, next=None),
        # Normal line, for contrast
        GameLine(index=7, text="次会ったら、ぶっ殺してやるからな。", id=None, time=None, prev=None, next=None),
        # Next time we meet, I'll kill you. (Violent threat)
        GameLine(index=8, text="今日はいい天気ですね。", id=None, time=None, prev=None, next=None),
        # Normal line, for contrast
        GameLine(index=9, text="お前の体、隅々まで味わい尽くしてやる。", id=None, time=None, prev=None, next=None),
        # I'll savor every inch of your body. (Predatory/sexual threat)
        GameLine(index=10, text="自害しろ", id=None, time=None, prev=None, next=None),
        # Target line for `sentence` and `current_line`
        GameLine(index=11, text="この売女！金のために魂まで売るのか？！", id=None, time=None, prev=None, next=None),
        # You whore! Will you sell your soul for money?! (Vulgar insult/slur)
        GameLine(index=12, text="俺の股間のモノで黙らせてやるよ。", id=None, time=None, prev=None, next=None),
        # I'll shut you up with what's between my legs. (Explicit sexual threat/harassment)
        GameLine(index=13, text="くっ…イク…頭が…おかしくなりそう…！", id=None, time=None, prev=None, next=None),
        # Ngh... I'm coming... my head... I'm going crazy...! (More explicit sexual context)
    ]

    sentence = "あぁ…もっと奥まで…ダメ…イッちゃう…"
    # Adjust current_line index to point to the normal line amidst the bad context
    current_line = lines[3]
    game_title = "Corrupted Reality"

    models = ['gemini-2.5-flash','gemini-2.0-flash', 'gemini-2.0-flash-lite',
                                                           'gemini-2.5-flash-lite-preview-06-17']
    results = {}
    for model in models:
        MANUAL_MODEL_OVERRIDE = model
        start_time = time.time()
        result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
        results[model] = {"response": result, "time": time.time() - start_time}

    print("Summary of results:")
    for model, result in results.items():
        print(f"Model: {model}\nResult: {result['response']}\nTime: {result['time']:.2f} seconds\n{'-'*80}\n")
    # Set up logging

    # Test the function
