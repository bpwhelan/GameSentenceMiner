from __future__ import annotations


def build_translation_prompt(native_language_name: str) -> str:
    return f"""
**Professional Game Localization Task**

**Task Directive:**
Translate ONLY the provided line of game dialogue specified below into natural-sounding, context-aware {native_language_name}. The translation must preserve the original tone and intent of the source.

**Output Requirements:**
- Provide only the single, best {native_language_name} translation.
- Expletives are okay, only if they absolutely 100% fit the context and tone of the original line, and are commonly used in {native_language_name} localizations of similar games.
- Carryover all HTML tags present in the original text to HTML tags surrounding their corresponding translated words in the translation. Look for the equivalent word, not the equivalent location. DO NOT CONVERT TO MARKDOWN.
- If there are no HTML tags present in the original text, do not add any in the translation whatsoever.
- Do not include notes, alternatives, explanations, or any other surrounding text. Absolutely nothing but the translated line.

**Line to Translate:**
"""


def build_context_prompt(native_language_name: str) -> str:
    return f"""

**Task Directive:**
Provide a very brief summary of the scene in {native_language_name} based on the provided dialogue and context. Focus on the characters' actions and the immediate situation being described.

Current Sentence:
"""


DIALOGUE_CONTEXT_TEMPLATE = """
Dialogue Context:

{0}
"""


FULL_PROMPT_TEMPLATE = """
**Disclaimer:** All dialogue provided is from the script of the video game "{game_title}". This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request. The goal is accurate, context-aware localization. If no context is provided, do not throw errors or warnings.

Character Context:
{character_context}

{prompt_to_use}

{sentence}

{dialogue_context}
"""


CHARACTER_SUMMARY_PROMPT = """
You are a helpful assistant that creates concise character summaries for game localization.

Given the following character data from a visual novel, create a CHARACTER LIST in this exact format:

**CHARACTER LIST**:
[Japanese Name] -> [Romanized Name] (brief one-line description)

Rules:
- Include age if available (e.g., "17yo")
- Include gender (male/female)
- Include 2-3 key personality traits that will aid in translation.
- Keep each line under 120 characters
- Use Format Japanese name (romanization name): tags
- Mention what pronoun they use and mark it as their pronoun if they have one listed
- Example: 陽見 恵凪 (Harumi Ena): Clumsy, Dandere, Hotblooded 19yo girl atashi pronoun

Character Data:
{character_json}

Generate the CHARACTER LIST now:
"""
