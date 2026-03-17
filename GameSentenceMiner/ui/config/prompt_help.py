from __future__ import annotations

from PyQt6.QtWidgets import (
    QDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
)


class PromptHelpDialog(QDialog):
    def __init__(self, target_text_edit, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Prompt Template Builder")
        self.resize(500, 450)
        self.target_text_edit = target_text_edit

        layout = QVBoxLayout(self)

        placeholders_group = QGroupBox("Insert Placeholders")
        grid = QGridLayout()

        placeholders = [
            ("{game_title}", "The title of the game."),
            ("{character_context}", "Character info (VNDB/Agent)."),
            ("{dialogue_context}", "Previous dialogue lines."),
            ("{prompt_to_use}", "Inner system prompt (Translation/Context)."),
            ("{sentence}", "The current line to process."),
        ]

        for i, (placeholder, desc) in enumerate(placeholders):
            btn = QPushButton(placeholder)
            btn.clicked.connect(lambda checked, text=placeholder: self.insert_text(text))
            grid.addWidget(btn, i, 0)

            lbl = QLabel(desc)
            lbl.setWordWrap(True)
            grid.addWidget(lbl, i, 1)

        placeholders_group.setLayout(grid)
        layout.addWidget(placeholders_group)

        templates_group = QGroupBox("Templates")
        t_layout = QVBoxLayout()

        default_btn = QPushButton("Load Default Full Template")
        default_btn.setToolTip("Replaces current text with the default full prompt template.")
        default_btn.clicked.connect(self.load_default_template)
        t_layout.addWidget(default_btn)

        canned_group = QGroupBox("Insert Canned Prompts")
        c_layout = QHBoxLayout()

        trans_btn = QPushButton("Translation Prompt")
        trans_btn.setToolTip("Inserts the default translation prompt.")
        trans_btn.clicked.connect(self.insert_translation_prompt)
        c_layout.addWidget(trans_btn)

        context_btn = QPushButton("Context Prompt")
        context_btn.setToolTip("Inserts the default context prompt.")
        context_btn.clicked.connect(self.insert_context_prompt)
        c_layout.addWidget(context_btn)

        canned_group.setLayout(c_layout)
        t_layout.addWidget(canned_group)

        templates_group.setLayout(t_layout)
        layout.addWidget(templates_group)

        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)

    def insert_text(self, text: str) -> None:
        cursor = self.target_text_edit.textCursor()
        if cursor.hasSelection():
            # Placeholder for future wrap/replace behavior.
            pass
        self.target_text_edit.insertPlainText(text)
        self.target_text_edit.setFocus()

    def insert_translation_prompt(self) -> None:
        from GameSentenceMiner.ai.ai_prompting import TRANSLATION_PROMPT

        self.insert_text(TRANSLATION_PROMPT)

    def insert_context_prompt(self) -> None:
        from GameSentenceMiner.ai.ai_prompting import CONTEXT_PROMPT

        self.insert_text(CONTEXT_PROMPT)

    def load_default_template(self) -> None:
        try:
            from GameSentenceMiner.ai.ai_prompting import FULL_PROMPT_TEMPLATE

            self.target_text_edit.setPlainText(FULL_PROMPT_TEMPLATE)
            self.target_text_edit.setFocus()
        except ImportError:
            fallback = """**Disclaimer:** All dialogue provided is from the script of the video game "{game_title}". This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request. The goal is accurate, context-aware localization. If no context is provided, do not throw errors or warnings.

Character Context:
{character_context}

{prompt_to_use}

{sentence}

Dialogue context:
{dialogue_context}
"""
            self.target_text_edit.setPlainText(fallback)
