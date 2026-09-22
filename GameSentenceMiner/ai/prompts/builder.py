from __future__ import annotations

import re
from dataclasses import dataclass

from GameSentenceMiner.ai.prompts.presets import build_study_prompt
from GameSentenceMiner.ai.prompts.templates import (
    DIALOGUE_CONTEXT_TEMPLATE,
    FULL_PROMPT_TEMPLATE,
    build_context_prompt,
    build_translation_prompt,
)
from GameSentenceMiner.util.text_log import GameLine


def expand_prompt_variables(template: str, values: dict[str, str]) -> str:
    # Substitute only our documented placeholders, once. JSON braces and braces
    # inside source dialogue must stay literal; str.format cannot do that safely.
    return re.sub(r"\{(" + "|".join(values) + r")\}", lambda match: values[match[1]], template)


@dataclass(frozen=True)
class PromptSelection:
    prompt_text: str
    prompt_kind: str


class DialogueContextBuilder:
    @staticmethod
    def build(lines: list[GameLine], current_line: GameLine, context_length: int) -> str:
        if context_length == 0 or not lines:
            return "No dialogue context available."

        if context_length == -1:
            start_index = 0
            end_index = len(lines)
        else:
            index = getattr(current_line, "index", None)
            if not isinstance(index, int) or not 0 <= index < len(lines):
                start_index = max(0, len(lines) - context_length)
                end_index = len(lines)
            else:
                start_index = max(0, index - context_length)
                end_index = min(len(lines), index + 1 + context_length)

        context_lines_text = []
        for i in range(start_index, end_index):
            if i < len(lines):
                context_lines_text.append(lines[i].text)

        return DIALOGUE_CONTEXT_TEMPLATE.format("\n".join(context_lines_text))


class PromptSelector:
    @staticmethod
    def select(
        use_canned_translation_prompt: bool,
        use_canned_context_prompt: bool,
        custom_prompt: str,
        native_language_name: str,
        custom_prompt_override: str | None = None,
        prompt_preset: str = "",
    ) -> PromptSelection:
        if custom_prompt_override:
            return PromptSelection(prompt_text=custom_prompt_override, prompt_kind="custom")
        if prompt_preset:
            if prompt_preset == "translation":
                return PromptSelection(build_translation_prompt(native_language_name), "translation")
            return PromptSelection(build_study_prompt(prompt_preset, native_language_name), prompt_preset)
        if use_canned_translation_prompt:
            return PromptSelection(
                prompt_text=build_translation_prompt(native_language_name),
                prompt_kind="translation",
            )
        if use_canned_context_prompt:
            return PromptSelection(
                prompt_text=build_context_prompt(native_language_name),
                prompt_kind="context",
            )
        return PromptSelection(prompt_text=custom_prompt, prompt_kind="custom")


class FullPromptRenderer:
    @staticmethod
    def render(
        game_title: str,
        character_context: str,
        dialogue_context: str,
        prompt_to_use: str,
        sentence: str,
        custom_full_prompt: str = "",
        native_language_name: str = "English",
    ) -> str:
        values = {
            "game_title": game_title or "Unknown",
            "character_context": character_context,
            "dialogue_context": dialogue_context,
            "sentence": sentence,
            "native_language": native_language_name,
        }
        values["prompt_to_use"] = expand_prompt_variables(prompt_to_use, values)
        template = custom_full_prompt.strip() or FULL_PROMPT_TEMPLATE
        if "{sentence}" not in template:
            raise ValueError("The full prompt template must include {sentence}.")
        return expand_prompt_variables(template, values)


class PromptBuilder:
    def __init__(self, native_language_name: str):
        self.native_language_name = native_language_name

    def build(
        self,
        lines: list[GameLine],
        sentence: str,
        current_line: GameLine,
        game_title: str,
        dialogue_context_length: int,
        use_canned_translation_prompt: bool,
        use_canned_context_prompt: bool,
        custom_prompt: str,
        custom_prompt_override: str | None = None,
        character_context: str = "",
        prompt_preset: str = "",
        custom_full_prompt: str = "",
    ) -> tuple[str, str]:
        dialogue_context = DialogueContextBuilder.build(lines, current_line, dialogue_context_length)
        selection = PromptSelector.select(
            use_canned_translation_prompt=use_canned_translation_prompt,
            use_canned_context_prompt=use_canned_context_prompt,
            custom_prompt=custom_prompt,
            native_language_name=self.native_language_name,
            custom_prompt_override=custom_prompt_override,
            prompt_preset=prompt_preset,
        )
        full_prompt = FullPromptRenderer.render(
            game_title=game_title,
            character_context=character_context,
            dialogue_context=dialogue_context,
            prompt_to_use=selection.prompt_text,
            sentence=sentence,
            custom_full_prompt=custom_full_prompt,
            native_language_name=self.native_language_name,
        )
        return full_prompt, selection.prompt_kind
