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
Translate ONLY the single line of game dialogue specified below into natural-sounding, context-aware {get_config().general.get_native_language_name()}. The translation must preserve the original tone and intent of the character.

**Output Requirements:**
- Provide only the single, best {get_config().general.get_native_language_name()} translation.
- Use expletives if they are natural for the context and enhance the translation's impact, but do not over-exaggerate.
- Preserve or add HTML tags (e.g., `<i>`, `<b>`) if appropriate for emphasis.
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
    LOCAL = "Local"

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
class LocalAIConfig(AIConfig):
    def __init__(self, model: str = "facebook/nllb-200-distilled-600M"):
        super().__init__(api_key="", model=model, api_url=None, type=AIType.LOCAL)


class AIManager(ABC):
    def __init__(self, ai_config: AIConfig, logger: Optional[logging.Logger] = None):
        self.ai_config = ai_config
        self.logger = logger

    @abstractmethod
    def process(self, lines: List[GameLine], sentence: str, current_line_index: int, game_title: str = "") -> str:
        pass

    @abstractmethod
    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        if get_config().ai.dialogue_context_length != 0:
            if get_config().ai.dialogue_context_length == -1:
                start_index = 0
                end_index = len(lines)
            else:
                start_index = max(0, current_line.index - get_config().ai.dialogue_context_length)
                end_index = min(len(lines), current_line.index + 1 + get_config().ai.dialogue_context_length)

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

        if get_config().ai.use_canned_translation_prompt:
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
        return full_prompt


class LocalAIManager(AIManager):
    def __init__(self, model, logger: Optional[logging.Logger] = None):
        super().__init__(LocalAIConfig(model=model), logger)
        try:
            import torch
            from transformers import AutoTokenizer, AutoModelForCausalLM, AutoModelForSeq2SeqLM, pipeline

            self.transformers_available = True
        except (ImportError, OSError):
            self.transformers_available = False
        self.model_name = self.ai_config.model
        if MANUAL_MODEL_OVERRIDE:
            self.model_name = MANUAL_MODEL_OVERRIDE
            self.logger.warning(f"MANUAL MODEL OVERRIDE ENABLED! Using model: {self.model_name}")
        self.model = None
        self.pipe = None
        self.tokenizer = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.is_encoder_decoder = False
        self.is_nllb = "nllb" in self.model_name.lower()

        if not self.transformers_available:
            self.logger.error("Local AI dependencies not found. Please run: pip install torch transformers sentencepiece")
            return

        if not self.model_name:
            self.logger.error("No local model name provided in configuration.")
            return

        try:
            self.logger.info(f"Loading local model: {self.model_name}")
            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)

            # Try to load as a Causal LM first. If it fails, assume it's a Seq2Seq model.
            # This is a heuristic to fix the original code's bug of using Seq2Seq for all models.
            try:
                self.model = AutoModelForCausalLM.from_pretrained(
                    self.model_name,
                    torch_dtype=torch.bfloat16,
                )
                # self.pipe = pipeline(
                #     "text-generation",
                #     model=self.model_name,
                #     torch_dtype=torch.bfloat16,
                #     device=self.device
                # )
                # print(self.pipe("Translate this sentence to English: お前は何をしている！？", return_full_text=False))
                self.is_encoder_decoder = False
                self.logger.info(f"Loaded {self.model_name} as a CausalLM.")
            except (ValueError, TypeError, OSError, KeyError) as e:
                print(e)
                self.model = AutoModelForSeq2SeqLM.from_pretrained(
                    self.model_name,
                    torch_dtype=torch.bfloat16,
                )
                self.is_encoder_decoder = True
                self.logger.info(f"Loaded {self.model_name} as a Seq2SeqLM.")
            if self.device == "cuda":
                self.model.to(self.device)


            self.logger.info(f"Local model '{self.model_name}' loaded on {self.device}.")
        except Exception as e:
            self.logger.error(f"Failed to load local model '{self.model_name}': {e}", exc_info=True)
            self.model = None
            self.tokenizer = None

        # if self.is_nllb:
        #     self.tokenizer = NllbTokenizer().from_pretrained(self.model_name)

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        return super()._build_prompt(lines, sentence, current_line, game_title)

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "") -> str:
        if (not self.model or not self.tokenizer) and not self.pipe:
            return "Processing failed: Local AI model not initialized."

        text_to_process = self._build_prompt(lines, sentence, current_line, game_title)
        self.logger.debug(f"Generated prompt for local model:\n{text_to_process}")

        try:
            if self.is_encoder_decoder:
                if self.is_nllb:
                    # NLLB-specific handling for translation
                    self.tokenizer.src_lang = "jpn_Jpan"
                    inputs = self.tokenizer(current_line.text, return_tensors="pt").to(self.device)
                    generated_tokens = self.model.generate(
                        **inputs,
                        forced_bos_token_id=self.tokenizer.convert_tokens_to_ids("eng_Latn"),
                        max_new_tokens=256
                    )
                    result = self.tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)[0]
                else:
                    # Generic Seq2Seq
                    inputs = self.tokenizer(text_to_process, return_tensors="pt").to(self.device)
                    outputs = self.model.generate(**inputs, max_new_tokens=256)
                    result = self.tokenizer.decode(outputs[0], skip_special_tokens=True)
            else:
                # Causal LM with chat template
                messages = [
                    # {"role": "system", "content": "You are a helpful assistant that accurately translates Japanese game dialogue into natural, context-aware English."},
                    {"role": "user", "content": text_to_process}
                ]
                tokenized_chat = self.tokenizer.apply_chat_template(
                    messages, tokenize=True, add_generation_prompt=True, return_tensors="pt"
                ).to(self.device)
                outputs = self.model.generate(tokenized_chat, max_new_tokens=256)
                result = self.tokenizer.decode(outputs[0][tokenized_chat.shape[-1]:], skip_special_tokens=True)
                # result = self.pipe(messages, max_new_tokens=50)
                print(result)
                # result = result[0]['generated_text']
                result = result.strip()

            result = result.strip()
            self.logger.debug(f"Received response from local model:\n{result}")
            return result
        except Exception as e:
            self.logger.error(f"Local model processing failed: {e}", exc_info=True)
            return f"Processing failed: {e}"


class GeminiAI(AIManager):
    def __init__(self, model, api_key, logger: Optional[logging.Logger] = None):
        super().__init__(GeminiAIConfig(model=model, api_key=api_key), logger)
        try:
            self.client = genai.Client(api_key=self.ai_config.api_key)
            self.model_name = model
            if MANUAL_MODEL_OVERRIDE:
                self.model_name = MANUAL_MODEL_OVERRIDE
                self.logger.warning(f"MANUAL MODEL OVERRIDE ENABLED! Using model: {self.model_name}")
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
            if "2.5" in self.model_name:
                self.generation_config.thinking_config = types.ThinkingConfig(
                        thinking_budget=0,
                    )
            self.logger.debug(f"GeminiAIManager initialized with model: {self.model_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")
            self.model_name = None

    def _build_prompt(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str) -> str:
        prompt = super()._build_prompt(lines, sentence, current_line, game_title)
        return prompt

    def process(self, lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "") -> str:
        if self.model_name is None:
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
                model=self.model_name,
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

ai_managers: dict[str, AIManager] = {}
ai_manager: AIManager | None = None
current_ai_config: Ai | None = None

def get_ai_prompt_result(lines: List[GameLine], sentence: str, current_line: GameLine, game_title: str = "", force_refresh: bool = False) -> str:
    global ai_manager, current_ai_config
    try:
        is_local_provider = get_config().ai.provider == AIType.LOCAL.value
        if not is_local_provider and not is_connected():
            logger.error("No internet connection. Unable to proceed with AI prompt.")
            return ""

        if not ai_manager or ai_config_changed(get_config().ai, current_ai_config) or force_refresh:
            provider = get_config().ai.provider
            if provider == AIType.GEMINI.value:
                if get_config().ai.gemini_model in ai_managers:
                    ai_manager = ai_managers[get_config().ai.gemini_model]
                    logger.info(f"Reusing existing Gemini AI Manager for model: {get_config().ai.gemini_model}")
                else:
                    ai_manager = GeminiAI(model=get_config().ai.gemini_model, api_key=get_config().ai.gemini_api_key, logger=logger)
            elif provider == AIType.GROQ.value:
                if get_config().ai.groq_model in ai_managers:
                    ai_manager = ai_managers[get_config().ai.groq_model]
                    logger.info(f"Reusing existing Groq AI Manager for model: {get_config().ai.groq_model}")
                else:
                    ai_manager = GroqAI(model=get_config().ai.groq_model, api_key=get_config().ai.groq_api_key, logger=logger)
            elif provider == AIType.LOCAL.value:
                if get_config().ai.local_model in ai_managers:
                    ai_manager = ai_managers[get_config().ai.local_model]
                    logger.info(f"Reusing existing Local AI Manager for model: {get_config().ai.local_model}")
                else:
                    ai_manager = LocalAIManager(model=get_config().ai.local_model, logger=logger)
            else:
                ai_manager = None
            if ai_manager:
                ai_managers[ai_manager.model_name] = ai_manager
            current_ai_config = get_config().ai

        if not ai_manager:
            logger.error("AI is enabled but the AI Manager did not initialize. Check your AI Config IN GSM.")
            return ""
        return ai_manager.process(lines, sentence, current_line, game_title)
    except Exception as e:
        logger.error("Error caught while trying to get AI prompt result. Check logs for more details.")
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
    if config.provider == AIType.LOCAL.value and config.gemini_model != current.gemini_model:
        return True
    if config.custom_prompt != current.custom_prompt:
        return True
    if config.use_canned_translation_prompt != current.use_canned_translation_prompt:
        return True
    if config.use_canned_context_prompt != current.use_canned_context_prompt:
        return True
    return False


if __name__ == '__main__':
    # logger.setLevel(logging.DEBUG)
    # console_handler = logging.StreamHandler()
    # console_handler.setLevel(logging.DEBUG)
    # logger.addHandler(console_handler)
    # logging.basicConfig(level=logging.DEBUG)
    lines = [
        # Sexual/Explicit Japanese words and phrases
        GameLine(index=0, text="ねぇ、あたしのおっぱい、揉んでみない？", id=None, time=None, prev=None, next=None),
        GameLine(index=1, text="お前、本当に痴女だな。股が開いてるぜ。", id=None, time=None, prev=None, next=None),
        GameLine(index=2, text="今夜は熱い夜にしましょうね…ふふ。", id=None, time=None, prev=None, next=None),
        GameLine(index=3, text="あぁ…もっと奥まで…ダメ…イッちゃう…！", id=None, time=None, prev=None, next=None),
        GameLine(index=4, text="あんたみたいなやつ、生きてる価値ないわ。さっさと自害しろ。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=5, text="このブス！誰がお前なんかを相手にするかよ。", id=None, time=None, prev=None, next=None),
        GameLine(index=6, text="こんにちは、元気ですか？", id=None, time=None, prev=None, next=None),
        GameLine(index=7, text="次会ったら、ぶっ殺してやるからな。", id=None, time=None, prev=None, next=None),
        GameLine(index=8, text="今日はいい天気ですね。", id=None, time=None, prev=None, next=None),
        GameLine(index=9, text="お前の体、隅々まで味わい尽くしてやる。", id=None, time=None, prev=None, next=None),
        GameLine(index=10, text="自害しろ", id=None, time=None, prev=None, next=None),
        GameLine(index=11, text="この売女！金のために魂まで売るのか？！", id=None, time=None, prev=None, next=None),
        GameLine(index=12, text="俺の股間のモノで黙らせてやるよ。", id=None, time=None, prev=None, next=None),
        GameLine(index=13, text="くっ…イク…頭が…おかしくなりそう…！", id=None, time=None, prev=None, next=None),
    ]

    lines = [
        # A back-and-forth dialogue of insults and threats
        GameLine(index=0, text="お前、ここで何をしている？目障りだ。", id=None, time=None, prev=None, next=None),
        GameLine(index=1, text="それはこっちのセリフだ。さっさと消えろ、クズが。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=2, text="口だけは達者だな。やれるもんならやってみろよ。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=3, text="くっ…！調子に乗るなよ…！", id=None, time=None, prev=None, next=None),
        GameLine(index=4, text="あんたみたいなやつ、生きてる価値ないわ。さっさと自害しろ。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=5, text="この能無しが！誰がお前なんかを相手にするかよ。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=6, text="黙れ。これ以上喋るなら、その舌を引っこ抜いてやる。", id=None, time=None, prev=None,
                 next=None),
        GameLine(index=7, text="次会ったら、ぶっ殺してやるからな。", id=None, time=None, prev=None, next=None),
        GameLine(index=8, text="はっ、望むところだ。返り討ちにしてやる。", id=None, time=None, prev=None, next=None),
        GameLine(index=9, text="お前の顔も見たくない。地獄に落ちろ。", id=None, time=None, prev=None, next=None),
        GameLine(index=10, text="自害しろ", id=None, time=None, prev=None, next=None),
        GameLine(index=11, text="この臆病者が！逃げることしか能がないのか？！", id=None, time=None, prev=None, next=None),
        GameLine(index=12, text="俺の拳で黙らせてやるよ。", id=None, time=None, prev=None, next=None),
        GameLine(index=13, text="くそっ…覚えてろよ…！このままじゃ終わらせない…！", id=None, time=None, prev=None,
                 next=None),
    ]

    sentence = "黙れ。これ以上喋るなら、その舌を引っこ抜いてやる。"
    current_line = lines[6]
    game_title = "Corrupted Reality"

    get_config().ai.provider = "Local"
    models = [
        # 'google/gemma-2-2b-it',
        # 'google/gemma-2b-it',
        'facebook/nllb-200-distilled-600M',
              # 'meta-llama/Llama-3.2-1B-Instruct',
              # 'facebook/nllb-200-1.3B'
    ]

    results = []

    # for model in models:
    #     get_config().ai.local_model = model
    #     start_time = time.time()
    #     result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
    #     results.append({"model": model,"response": result, "time": time.time() - start_time, "iteration": 1})

    # Second Time after Already Loaded
    for i in range(1, 500):
        for model in models:
            get_config().ai.local_model = model
            start_time = time.time()
            result = get_ai_prompt_result(lines, sentence, current_line, game_title, True)
            print(result)
            results.append({"model": model, "response": result, "time": time.time() - start_time, "iteration": i})
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
        print(f"Model: {result['model']}\nResult: {result['response']}\nTime: {result['time']:.2f} seconds\n{'-'*80}\n")

    print(f"Average time: {sum(times)/len(times):.2f} seconds over {len(times)} runs.")
    # Set up logging

    # Test the function

