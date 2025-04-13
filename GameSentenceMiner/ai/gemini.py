import google.generativeai as genai

from GameSentenceMiner.configuration import get_config, logger

MODEL = "gemini-2.0-flash"  # or "gemini-pro-vision" if you need image support

genai.configure(api_key=get_config().ai.api_key)
model = genai.GenerativeModel(MODEL)

def translate_with_context(lines, sentence, current_line_index, game_title=""):
    """
    Translates a line of dialogue with context from surrounding lines.

    Args:
        lines: A list of strings representing the dialogue lines.
        sentence: Sentence to get translation for
        current_line_index: The index of the line to translate.
        game_title: Optional title of the game for added context.

    Returns:
        A string containing the translated sentence with context.
    """

    if not lines or current_line_index < 0 or current_line_index >= len(lines):
        return "Invalid input."

    context_lines = []

    # Get the previous 10 lines (or fewer if at the beginning)
    for i in range(max(0, current_line_index - 10), current_line_index):
        context_lines.append(lines[i].text)

    # Get the current line
    current_line = lines[current_line_index]
    context_lines.append(current_line.text)

    #Get the next 10 lines (or fewer if at the end)
    for i in range(current_line_index + 1, min(current_line_index + 11, len(lines))):
        context_lines.append(lines[i].text)

    ai_config = get_config().ai

#this is ugly, but prettier in the output... so idk
    if ai_config.use_canned_translation_prompt:
        prompt_to_use = \
f"""
Translate the following Japanese dialogue from the game {game_title} into natural, context-aware English. Focus on preserving the tone, intent, and emotional nuance of the original text, paying close attention to the context provided by surrounding lines. The dialogue may include slang, idioms, implied meanings, or game-specific terminology that should be adapted naturally for English-speaking players. Ensure the translation feels immersive and aligns with the game's narrative style and character voices.
Translate only the specified line below, providing a single result. Do not include additional text, explanations, or other lines unless explicitly requested. Allow expletives if more natural. Allow HTML tags for emphasis, italics, and other formatting as needed. Please also try to preserve existing HTML tags from the specified sentence if appropriate.

Line to Translate:
"""
    elif ai_config.use_canned_context_prompt:
        prompt_to_use = \
f"""
Provide a very brief summary of the scene in English based on the provided Japanese dialogue and context. Focus on the characters' actions and the immediate situation being described.

Current Sentence:
"""
    else:
        prompt_to_use = ai_config.custom_prompt


    prompt = \
f"""
Dialogue Context:

{chr(10).join(context_lines)}

I am playing the game {game_title}. With that, and the above dialogue context in mind, answer the following prompt.

{prompt_to_use}

{sentence}
"""

    logger.debug(prompt)
    try:
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        return f"Translation failed: {e}"

# Example Usage: Zero Escape: 999 examples

# zero_escape_dialogue1 = [
#     "扉は開いた…？",
#     "まさか、こんな仕掛けが…",
#     "一体、何が起こっているんだ？",
#     "この数字の意味は…？",
#     "落ち着いて、考えるんだ。",
#     "でも、時間が…",
#     "まだ、諦めるな！",
#     "一体、誰が…？",
#     "まさか、あの人が…？",
#     "もう、ダメだ…",
#     "まだ、希望はある！",
#     "この部屋から、脱出するんだ！",
#     "でも、どうやって…？",
#     "何か、手がかりがあるはずだ！",
#     "早く、見つけないと…",
# ]
#
#
# current_line_index = 3
# translation = translate_with_context(zero_escape_dialogue1, current_line_index, "Zero Escape: 999")
# print(f"Original: {zero_escape_dialogue1[current_line_index]}")
# print(f"Translation: {translation}")
#
# # Example with fewer context lines at the beginning.
# zero_escape_dialogue2 = [
#     "このアミュレット…",
#     "何かを感じる…",
#     "この数字は…",
#     "９…？",
#     "まさか、これは…",
#     "何かの手がかり…？",
#     "急がないと…",
#     "時間がない…",
#     "早く、脱出を…",
# ]
#
# current_line_index = 3
# translation = translate_with_context(zero_escape_dialogue2, current_line_index, "Zero Escape: 999")
# print(f"Original: {zero_escape_dialogue2[current_line_index]}")
# print(f"Translation: {translation}")
#
# #example with fewer context lines at the end.
# zero_escape_dialogue3 = [
#     "この状況、理解できない。",
#     "誰かが、私たちを閉じ込めたのか？",
#     "なぜ、こんなことを…？",
#     "このゲームの目的は…？",
#     "一体、何が真実なんだ？",
#     "信じられるのは、誰…？",
#     "疑心暗鬼になるな。",
#     "でも、どうすれば…？",
#     "とにかく、進むしかない。"
# ]
#
# current_line_index = 4
# translation = translate_with_context(zero_escape_dialogue3, current_line_index, "Zero Escape: 999")
# print(f"Original: {zero_escape_dialogue3[current_line_index]}")
# print(f"Translation: {translation}")
