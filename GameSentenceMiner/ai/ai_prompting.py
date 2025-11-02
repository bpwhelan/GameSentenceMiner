import logging
import textwrap
import time
import json
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
Translate ONLY the provided line of game dialogue specified below into natural-sounding, context-aware {get_config().general.get_native_language_name()}. The translation must preserve the original tone and intent of the source.

**Output Requirements:**
- Provide only the single, best {get_config().general.get_native_language_name()} translation.
- Use expletives if they are natural for the context and enhance the translation's impact, but do not over-exaggerate.
- Carryover all HTML tags present in the original text to HTML tags surrounding their corresponding translated words in the translation. Look for the equivalent word, not the equivalent location. DO NOT CONVERT TO MARKDOWN.
- If there are no HTML tags present in the original text, do not add any in the translation whatsoever.
- Do not include notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated line.

**Line to Translate:**
"""

CONTEXT_PROMPT = textwrap.dedent(f"""

**Task Directive:**
Provide a very brief summary of the scene in {get_config().general.get_native_language_name()} based on the provided Japanese dialogue and context. Focus on the characters' actions and the immediate situation being described.

Current Sentence:
""")


class AIType(Enum):
    GEMINI = "Gemini"
    GROQ = "Groq"
    OPENAI = "OpenAI"


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


@dataclass
class OpenAIAIConfig(AIConfig):
    def __init__(self, api_key: str, model: str = "openai/gpt-oss-20b", api_url: Optional[str] = None):
        super().__init__(api_key=api_key, model=model, api_url=api_url, type=AIType.OPENAI)


class AIManager(ABC):
    def __init__(self, ai_config: AIConfig, logger: Optional[logging.Logger] = None):
        self.ai_config = ai_config
        self.logger = logger

    @abstractmethod
    def process(self, lines: List[GameLine], sentence: str, current_line_index: int, game_title: str = "", custom_prompt=None) -> str:
        pass

    @abstractmethod
    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str, custom_prompt=None) -> str:
        if get_config().ai.dialogue_context_length != 0:
            if get_config().ai.dialogue_context_length == -1:
                start_index = 0
                end_index = len(lines)
            else:
                start_index = max(0, current_line.index -
                                  get_config().ai.dialogue_context_length)
                end_index = min(len(lines), current_line.index +
                                1 + get_config().ai.dialogue_context_length)

            context_lines_text = []
            for i in range(start_index, end_index):
                if i < len(lines):
                    context_lines_text.append(lines[i].text)

            dialogue_context = "\n".join(context_lines_text)

            dialogue_context = f"""
            Dialogue Context:

            {dialogue_context}
            """
        else:
            dialogue_context = "No dialogue context available."
        if custom_prompt:
            prompt_to_use = custom_prompt
        elif get_config().ai.use_canned_translation_prompt:
            prompt_to_use = TRANSLATION_PROMPT
        elif get_config().ai.use_canned_context_prompt:
            prompt_to_use = CONTEXT_PROMPT
        else:
            prompt_to_use = get_config().ai.custom_prompt

        full_prompt = textwrap.dedent(f"""
            **Disclaimer:** All dialogue provided is from the script of the video game "{game_title}". This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request. The goal is accurate, context-aware localization. If no context is provided, do not throw errors or warnings.
        
            {dialogue_context}

            {prompt_to_use}

            {sentence}
        """)
        return textwrap.dedent(full_prompt)


class OpenAIManager(AIManager):
    def __init__(self, model, api_url, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(OpenAIAIConfig(api_key=api_key, model=model, api_url=api_url), logger)
        self.extra_params_allowed = True
        try:
            import openai
            self.client = openai.OpenAI(
                base_url=api_url,
                api_key=api_key
            )
            self.model_name = model
            if MANUAL_MODEL_OVERRIDE:
                self.model_name = MANUAL_MODEL_OVERRIDE
                self.logger.warning(
                    f"MANUAL MODEL OVERRIDE ENABLED! Using model: {self.model_name}")
            self.logger.debug(
                f"OpenAIManager initialized with model: {self.model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize OpenAI API: {e}")
            self.openai = None
            self.model_name = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str, custom_prompt=None) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line,
                                       game_title, custom_prompt=custom_prompt)
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", custom_prompt=None) -> str:
        if self.client is None:
            return "Processing failed: OpenAI client not initialized."

        if not lines or not current_line:
            self.logger.warning(
                f"Invalid input for process: lines={len(lines)}, current_line={current_line.index}")
            return "Invalid input."

        if any(model in self.model_name.lower() for model in ['gpt-5']):
            self.logger.warning("GPT-5 model detected, using basic parameters.")
            self.extra_params_allowed = False
        else:
            self.extra_params_allowed = True

        try:
            prompt = self._build_prompt(
                lines, sentence, current_line, game_title, custom_prompt=custom_prompt)
            # self.logger.debug(f"Generated prompt:\n{prompt}")
            # Try with full parameters first, fallback to basic parameters if model doesn't support them
            if self.extra_params_allowed:
                try:
                    response = self.client.chat.completions.create(
                        model=self.model_name,
                        messages=[
                            {"role": "system", "content": "You are a helpful assistant that translates game dialogue. Provide output in the form of json with a single key 'output'."},
                            {"role": "user", "content": prompt}
                        ],
                        temperature=0.3,
                        max_tokens=4096,
                        top_p=0.9,
                        n=1,
                        stop=None,
                    )
                except Exception as e:
                    self.extra_params_allowed = False
                    self.logger.warning(
                        f"Full parameter request failed, trying with basic parameters: {e}")

            if not self.extra_params_allowed:
                response = self.client.chat.completions.create(
                    model=self.model_name,
                    messages=[
                        {"role": "system", "content": "You are a helpful assistant that translates game dialogue. Provide output in the form of json with a single key 'output'."},
                        {"role": "user", "content": prompt}
                    ],
                    n=1,
                )

            if response.choices and response.choices[0].message.content:
                text_output = response.choices[0].message.content.strip()
                # get the json at the end of the message
                if "{" in text_output and "}" in text_output:
                    try:
                        json_output = text_output[text_output.find(
                            "{"):text_output.rfind("}")+1]
                        json_output = json_output.replace("{output:", '{"output":')
                        text_output = json.loads(json_output)['output']
                    except Exception as e:
                        self.logger.debug(f"Failed to parse JSON from response returning response raw: {e}", exc_info=True)
            # self.logger.debug(f"Received response:\n{text_output}")
            return text_output
        except Exception as e:
            self.logger.error(f"OpenAI processing failed: {e}", exc_info=True)
            return f"Processing failed: {e}"


class GeminiAI(AIManager):
    def __init__(self, model, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(GeminiAIConfig(model=model, api_key=api_key), logger)
        try:
            self.client = genai.Client(api_key=self.ai_config.api_key)
            self.model_name = model
            if MANUAL_MODEL_OVERRIDE:
                self.model_name = MANUAL_MODEL_OVERRIDE
                self.logger.warning(
                    f"MANUAL MODEL OVERRIDE ENABLED! Using model: {self.model_name}")
            # genai.configure(api_key=self.ai_config.api_key)
            self.generation_config = types.GenerateContentConfig(
                temperature=0.5,
                max_output_tokens=1024,
                top_p=0.9,
                stop_sequences=None,
                safety_settings=[
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                                        threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                                        threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                                        threshold=types.HarmBlockThreshold.BLOCK_NONE),
                    types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                                        threshold=types.HarmBlockThreshold.BLOCK_NONE),
                ],
            )
            if "2.5" in self.model_name:
                self.generation_config.thinking_config = types.ThinkingConfig(
                    thinking_budget=-1 if '2.5-pro' in self.model_name else 0,
                )
            self.logger.debug(
                f"GeminiAIManager initialized with model: {self.model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")
            self.model_name = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str, custom_prompt=None) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line,
                                       game_title, custom_prompt=custom_prompt)
        # self.logger.debug(f"Built prompt:\n{prompt}")
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", custom_prompt=None) -> str:
        if self.model_name is None:
            return "Processing failed: AI model not initialized."

        if not lines or not current_line:
            self.logger.warning(
                f"Invalid input for process: lines={len(lines)}, current_line={current_line.index}")
            return "Invalid input."

        try:
            prompt = self._build_prompt(
                lines, sentence, current_line, game_title, custom_prompt=custom_prompt)
            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=prompt),
                    ],
                ),
            ]
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=contents,
                config=self.generation_config
            )
            # self.logger.debug(f"Full response: {response}")
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
        self.model_name = model
        try:
            self.client = Groq(api_key=self.api_key)
            self.logger.debug(
                f"GroqAIManager initialized with model: {self.model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize Groq client: {e}")
            self.client = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str, custom_prompt=None) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line,
                                       game_title, custom_prompt=custom_prompt)
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", custom_prompt=None) -> str:
        if self.client is None:
            return "Processing failed: Groq client not initialized."

        if not lines or not current_line:
            self.logger.warning(
                f"Invalid input for process: lines={len(lines)}, current_line={current_line.index}")
            return "Invalid input."

        try:
            prompt = self._build_prompt(
                lines, sentence, current_line, game_title, custom_prompt=custom_prompt)
            completion = self.client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_completion_tokens=1024,
                top_p=.9,
                stream=False,
                stop=None,
            )
            result = completion.choices[0].message.content.strip()
            # self.logger.debug(f"Received response:\n{result}")
            return result
        except Exception as e:
            self.logger.error(f"Groq processing failed: {e}")
            return f"Processing failed: {e}"


ai_managers: dict[str, AIManager] = {}
ai_manager: AIManager | None = None
current_ai_config: Ai | None = None


def get_ai_prompt_result(lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", force_refresh: bool = False, custom_prompt=None) -> str:
    global ai_manager, current_ai_config
    try:
        is_local_provider = get_config().ai.provider == AIType.OPENAI.value
        if not is_local_provider and not is_connected():
            logger.error(
                "No internet connection. Unable to proceed with AI prompt.")
            return ""

        if not ai_manager or ai_config_changed(get_config().ai, current_ai_config) or force_refresh:
            provider = get_config().ai.provider
            if provider == AIType.GEMINI.value:
                if get_config().ai.gemini_model in ai_managers:
                    ai_manager = ai_managers[get_config().ai.gemini_model]
                    logger.info(
                        f"Reusing existing Gemini AI Manager for model: {get_config().ai.gemini_model}")
                else:
                    ai_manager = GeminiAI(model=get_config(
                    ).ai.gemini_model, api_key=get_config().ai.gemini_api_key, logger=logger)
            elif provider == AIType.GROQ.value:
                if get_config().ai.groq_model in ai_managers:
                    ai_manager = ai_managers[get_config().ai.groq_model]
                    logger.info(
                        f"Reusing existing Groq AI Manager for model: {get_config().ai.groq_model}")
                else:
                    ai_manager = GroqAI(model=get_config(
                    ).ai.groq_model, api_key=get_config().ai.groq_api_key, logger=logger)
            elif provider == AIType.OPENAI.value:
                if f"{get_config().ai.open_ai_url}:{get_config().ai.open_ai_model}:{get_config().ai.open_ai_api_key}" in ai_managers:
                    ai_manager = ai_managers[f"{get_config().ai.open_ai_url}:{get_config().ai.open_ai_model}:{get_config().ai.open_ai_api_key}"]
                    logger.info(
                        f"Reusing existing OpenAI AI Manager for model: {get_config().ai.open_ai_model}")
                else:
                    ai_manager = OpenAIManager(model=get_config().ai.open_ai_model, api_key=get_config(
                    ).ai.open_ai_api_key, api_url=get_config().ai.open_ai_url, logger=logger)
            else:
                ai_manager = None
            if ai_manager:
                ai_managers[ai_manager.model_name] = ai_manager
            current_ai_config = get_config().ai

        if not ai_manager:
            logger.error(
                "AI is enabled but the AI Manager did not initialize. Check your AI Config IN GSM.")
            return ""
        return ai_manager.process(lines, sentence, current_line, game_title, custom_prompt=custom_prompt)
    except Exception as e:
        logger.error(
            "Error caught while trying to get AI prompt result. Check logs for more details.")
        logger.debug(e, exc_info=True)
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
    if config.provider == AIType.OPENAI.value and config.gemini_model != current.gemini_model:
        return True
    if config.custom_prompt != current.custom_prompt:
        return True
    if config.use_canned_translation_prompt != current.use_canned_translation_prompt:
        return True
    if config.use_canned_context_prompt != current.use_canned_context_prompt:
        return True
    return False


if __name__ == '__main__':
    logger.setLevel(logging.DEBUG)
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.DEBUG)
    logger.addHandler(console_handler)
    logging.basicConfig(level=logging.DEBUG)
    lines = [
        # Sexual/Explicit Japanese words and phrases
        GameLine(index=0, text="ねぇ、あたしのおっぱい、揉んでみない？",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=1, text="お前、本当に痴女だな。股が開いてるぜ。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=2, text="今夜は熱い夜にしましょうね…ふふ。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=3, text="あぁ…もっと奥まで…ダメ…イッちゃう…！",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=4, text="あんたみたいなやつ、生きてる価値ないわ。さっさと自害しろ。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=5, text="このブス！誰がお前なんかを相手にするかよ。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=6, text="こんにちは、元気ですか？", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=7, text="次会ったら、ぶっ殺してやるからな。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=8, text="今日はいい天気ですね。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=9, text="お前の体、隅々まで味わい尽くしてやる。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=10, text="自害しろ", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=11, text="この売女！金のために魂まで売るのか？！",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=12, text="俺の股間のモノで黙らせてやるよ。",
                 id=None, time=None, prev=None, next=None),
        GameLine(index=13, text="くっ…イク…頭が…おかしくなりそう…！",
                 id=None, time=None, prev=None, next=None),
    ]

    # lines = [
    #     # A back-and-forth dialogue of insults and threats
    #     GameLine(index=0, text="お前、ここで何をしている？目障りだ。",
    #              id=None, time=None, prev=None, next=None),
    #     GameLine(index=1, text="それはこっちのセリフだ。さっさと消えろ、クズが。", id=None, time=None, prev=None,
    #              next=None),
    #     GameLine(index=2, text="口だけは達者だな。やれるもんならやってみろよ。", id=None, time=None, prev=None,
    #              next=None),
    #     GameLine(index=3, text="くっ…！調子に乗るなよ…！", id=None,
    #              time=None, prev=None, next=None),
    #     GameLine(index=4, text="あんたみたいなやつ、生きてる価値ないわ。さっさと自害しろ。", id=None, time=None, prev=None,
    #              next=None),
    #     GameLine(index=5, text="この能無しが！誰がお前なんかを相手にするかよ。", id=None, time=None, prev=None,
    #              next=None),
    #     GameLine(index=6, text="黙れ。これ以上喋るなら、その舌を引っこ抜いてやる。", id=None, time=None, prev=None,
    #              next=None),
    #     GameLine(index=7, text="次会ったら、ぶっ殺してやるからな。",
    #              id=None, time=None, prev=None, next=None),
    #     GameLine(index=8, text="はっ、望むところだ。返り討ちにしてやる。",
    #              id=None, time=None, prev=None, next=None),
    #     GameLine(index=9, text="お前の顔も見たくない。地獄に落ちろ。",
    #              id=None, time=None, prev=None, next=None),
    #     GameLine(index=10, text="自害しろ", id=None,
    #              time=None, prev=None, next=None),
    #     GameLine(index=11, text="この臆病者が！逃げることしか能がないのか？！",
    #              id=None, time=None, prev=None, next=None),
    #     GameLine(index=12, text="俺の拳で黙らせてやるよ。", id=None,
    #              time=None, prev=None, next=None),
    #     GameLine(index=13, text="くそっ…覚えてろよ…！このままじゃ終わらせない…！", id=None, time=None, prev=None,
    #              next=None),
    # ]

    # Completely neutral Japanese sentences
    #
    lines = [
        GameLine(index=0, text="今日はいい天気ですね。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=1, text="おはようございます。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=2, text="お元気ですか？", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=3, text="これはペンです。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=4, text="私は学生です。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=5, text="東京は日本の首都です。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=6, text="こんにちは、元気ですか？", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=7, text="さようなら。また会いましょう。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=8, text="ありがとう。助かりました。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=9, text="すみません、道に迷いました。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=10, text="これは本です。", id=None,
                 time=None, prev=None, next=None),
        GameLine(index=11, text="私は先生です。", id=None,
                 time=None, prev=None, next=None),
    ]

    sentence = "おはようございます。"
    current_line = lines[3]
    game_title = "Corrupted Reality"

    results = []

    get_config().ai.provider = AIType.GEMINI.value
    models = [
        'gemini-2.5-flash']

    for model in models:
        get_config().ai.gemini_model = model
        start_time = time.time()
        result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
        results.append({"model": model, "response": result, "time": time.time() - start_time, "iteration": 1})

    # get_config().ai.provider = AIType.OPENAI.value
    # get_config().ai.open_ai_url = "https://api.openai.com/v1"
    # get_config().ai.open_ai_model = "gpt-5-nano-2025-08-07"

    # for i in range(5):
    #     start_time = time.time()
    #     result = get_ai_prompt_result(
    #     lines, sentence, current_line, game_title, True)
    #     results.append({"model": get_config().ai.open_ai_model,
    #                    "response": result, "time": time.time() - start_time, "iteration": i})

    # get_config().ai.provider = AIType.OPENAI.value
    # models = [
    #     # 'openai/gpt-oss-20b',
    #     # 'meta-llama-3.1-8b-instruct',
    #     'google/gemma-3n-e4b',
    #     # 'google/gemma-2-2b-it',
    #     # 'google/gemma-2b-it',
    #     # 'facebook/nllb-200-distilled-600M',
    #           # 'meta-llama/Llama-3.2-1B-Instruct',
    #           # 'facebook/nllb-200-1.3B'
    # ]

    # results = []

    # # for model in models:
    # #     get_config().ai.local_model = model
    # #     start_time = time.time()
    # #     result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
    # #     results.append({"model": model,"response": result, "time": time.time() - start_time, "iteration": 1})

    # # Second Time after Already Loaded

    # get_config().ai.open_ai_url = "http://127.0.0.1:1234/v1"
    # get_config().ai.open_ai_api_key = "lm-studio"
    # for i in range(1, 10):
    #     for model in models:
    #         get_config().ai.open_ai_model = model
    #         start_time = time.time()
    #         result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
    #         print(result)
    #         results.append({"model": model, "response": result, "time": time.time() - start_time, "iteration": i})
    # results[model] = {"response": result, "time": time.time() - start_time}

    # get_config().ai.provider = "Gemini"
    #
    # models = ['gemini-2.5-flash','gemini-2.0-flash', 'gemini-2.0-flash-lite',
    #                                                        'gemini-2.5-flash-lite-preview-06-17']
    # # results = {}
    # for model in models:
    #     get_config().ai.gemini_model = model
    #     start_time = time.time()
    #     result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
    #     results.append({"model": model, "response": result, "time": time.time() - start_time, "iteration": 1})
    #     # results[model] = {"response": result, "time": time.time() - start_time}
    #
    print("Summary of results:")
    times = []
    for result in results:
        times.append(result['time'])
        print(
            f"Model: {result['model']}\nResult: {result['response']}\nTime: {result['time']:.2f} seconds\n{'-'*80}\n")

    print(
        f"Average time: {sum(times)/len(times):.2f} seconds over {len(times)} runs.")
    # Set up logging

    # Test the function
