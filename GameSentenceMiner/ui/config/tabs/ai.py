from __future__ import annotations

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_ai_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "enabled"), window.ai_enabled_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "provider"), window.ai_provider_combo)

    window.gemini_settings_group.setTitle("Google Gemini Settings")
    window.gemini_settings_group.setStyleSheet(window._get_group_box_style())
    gemini_layout = QFormLayout()

    gemini_model_widget = QWidget()
    gemini_model_layout = QHBoxLayout(gemini_model_widget)
    gemini_model_layout.setContentsMargins(0, 0, 0, 0)
    gemini_model_layout.addWidget(window.gemini_model_combo)
    gemini_refresh_button = QPushButton("↻")
    gemini_refresh_button.setToolTip("Refresh Gemini models")
    gemini_refresh_button.setMaximumWidth(40)
    gemini_refresh_button.clicked.connect(lambda: window.refresh_ai_models("gemini"))
    gemini_model_layout.addWidget(gemini_refresh_button)

    gemini_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "gemini_model"), gemini_model_widget)
    gemini_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "gemini_backup_model",
            "Optional backup Gemini model used if the primary model fails.",
        ),
        window.gemini_backup_model_combo,
    )
    gemini_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "gemini_api_key"), window.gemini_api_key_edit)
    window.gemini_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
    window.gemini_settings_group.setLayout(gemini_layout)
    layout.addRow(window.gemini_settings_group)

    window.groq_settings_group.setTitle("Groq Settings")
    window.groq_settings_group.setStyleSheet(window._get_group_box_style())
    groq_layout = QFormLayout()

    groq_model_widget = QWidget()
    groq_model_layout = QHBoxLayout(groq_model_widget)
    groq_model_layout.setContentsMargins(0, 0, 0, 0)
    groq_model_layout.addWidget(window.groq_model_combo)
    groq_refresh_button = QPushButton("↻")
    groq_refresh_button.setToolTip("Refresh Groq models")
    groq_refresh_button.setMaximumWidth(40)
    groq_refresh_button.clicked.connect(lambda: window.refresh_ai_models("groq"))
    groq_model_layout.addWidget(groq_refresh_button)

    groq_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "groq_model"), groq_model_widget)
    groq_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "groq_backup_model",
            "Optional backup Groq model used if the primary model fails.",
        ),
        window.groq_backup_model_combo,
    )
    groq_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "groq_api_key"), window.groq_api_key_edit)
    window.groq_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
    window.groq_settings_group.setLayout(groq_layout)
    layout.addRow(window.groq_settings_group)

    window.openai_settings_group.setTitle("OpenAI-Compatible API Settings")
    window.openai_settings_group.setStyleSheet(window._get_group_box_style())
    openai_layout = QFormLayout()

    openai_model_widget = QWidget()
    openai_model_layout = QHBoxLayout(openai_model_widget)
    openai_model_layout.setContentsMargins(0, 0, 0, 0)
    openai_model_layout.addWidget(window.open_ai_model_edit)
    openai_refresh_button = QPushButton("↻")
    openai_refresh_button.setToolTip("Refresh OpenAI models")
    openai_refresh_button.setMaximumWidth(40)
    openai_refresh_button.clicked.connect(lambda: window.refresh_ai_models("openai"))
    openai_model_layout.addWidget(openai_refresh_button)

    openai_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "openai_url"), window.open_ai_url_edit)
    openai_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "openai_model"), openai_model_widget)
    openai_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "openai_backup_model",
            "Optional backup OpenAI model used if the primary model fails.",
        ),
        window.open_ai_backup_model_edit,
    )
    openai_layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "openai_apikey"), window.open_ai_api_key_edit)
    window.open_ai_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
    window.openai_settings_group.setLayout(openai_layout)
    layout.addRow(window.openai_settings_group)

    window.gsm_cloud_settings_group.setTitle("GSM Cloud Settings")
    window.gsm_cloud_settings_group.setStyleSheet(window._get_group_box_style())
    gsm_cloud_layout = QFormLayout()
    gsm_cloud_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "gsm_cloud_models",
            "Select GSM Cloud model(s). The first selected model is used for requests.",
        ),
        window.gsm_cloud_model_list,
    )
    gsm_cloud_layout.addRow(
        QLabel("Authenticate in the GSM Cloud tab to unlock this provider."),
    )
    window.gsm_cloud_settings_group.setLayout(gsm_cloud_layout)
    layout.addRow(window.gsm_cloud_settings_group)

    window.ollama_settings_group.setTitle("Ollama Settings")
    window.ollama_settings_group.setStyleSheet(window._get_group_box_style())
    ollama_layout = QFormLayout()

    ollama_model_widget = QWidget()
    ollama_model_layout = QHBoxLayout(ollama_model_widget)
    ollama_model_layout.setContentsMargins(0, 0, 0, 0)
    ollama_model_layout.addWidget(window.ollama_model_combo)
    ollama_refresh_button = QPushButton("↻")
    ollama_refresh_button.setToolTip("Refresh Ollama models")
    ollama_refresh_button.setMaximumWidth(40)
    ollama_refresh_button.clicked.connect(lambda: window.refresh_ai_models("ollama"))
    ollama_model_layout.addWidget(ollama_refresh_button)

    ollama_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "ollama_url", "The URL of your Ollama server"),
        window.ollama_url_edit,
    )
    ollama_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "ollama_model", "The model name to use in Ollama"),
        ollama_model_widget,
    )
    ollama_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "ollama_backup_model",
            "Optional backup Ollama model used if the primary model fails.",
        ),
        window.ollama_backup_model_combo,
    )
    window.ollama_settings_group.setLayout(ollama_layout)
    layout.addRow(window.ollama_settings_group)

    window.lm_studio_settings_group.setTitle("LM Studio Settings")
    window.lm_studio_settings_group.setStyleSheet(window._get_group_box_style())
    lm_studio_layout = QFormLayout()

    lm_studio_model_widget = QWidget()
    lm_studio_model_layout = QHBoxLayout(lm_studio_model_widget)
    lm_studio_model_layout.setContentsMargins(0, 0, 0, 0)
    lm_studio_model_layout.addWidget(window.lm_studio_model_combo)
    # refresh icon utf8
    lm_studio_refresh_button = QPushButton("↻")
    lm_studio_refresh_button.setToolTip("Refresh LM Studio models")
    lm_studio_refresh_button.setMaximumWidth(40)
    lm_studio_refresh_button.clicked.connect(lambda: window.refresh_ai_models("lm_studio"))
    lm_studio_model_layout.addWidget(lm_studio_refresh_button)

    lm_studio_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "lm_studio_url", "The URL of your LM Studio server"),
        window.lm_studio_url_edit,
    )
    lm_studio_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "lm_studio_model", "The model name to use in LM Studio"),
        lm_studio_model_widget,
    )
    lm_studio_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "lm_studio_backup_model",
            "Optional backup LM Studio model used if the primary model fails.",
        ),
        window.lm_studio_backup_model_combo,
    )
    lm_studio_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "lm_studio_api_key", "API Key (usually \"lm-studio\")"),
        window.lm_studio_api_key_edit,
    )
    window.lm_studio_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
    window.lm_studio_settings_group.setLayout(lm_studio_layout)
    layout.addRow(window.lm_studio_settings_group)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "anki_field"), window.ai_anki_field_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "context_length", color=LabelColor.ADVANCED), window.ai_dialogue_context_length_edit)
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "temperature",
            default_tooltip="Be careful: higher values make outputs more random.",
            color=LabelColor.ADVANCED,
            bold=True,
        ),
        window.ai_temperature_edit,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "max_output_tokens",
            default_tooltip="Be careful: higher values can increase cost and latency.",
            color=LabelColor.ADVANCED,
            bold=True,
        ),
        window.ai_max_output_tokens_edit,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "top_p",
            default_tooltip="Be careful: higher values allow more diverse outputs.",
            color=LabelColor.ADVANCED,
            bold=True,
        ),
        window.ai_top_p_edit,
    )

    window._update_ai_provider_visibility()

    layout.addRow(window._create_reset_button("ai", window._create_ai_tab))
    return widget


def build_ai_prompts_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "use_canned_translation"),
        window.use_canned_translation_prompt_check,
    )
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "use_canned_context"),
        window.use_canned_context_prompt_check,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "ai", "custom_prompt"), window.custom_prompt_textedit)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "ai", "custom_texthooker_prompt"), window.custom_texthooker_prompt_textedit
    )

    custom_full_prompt_widget = QWidget()
    cfp_layout = QVBoxLayout(custom_full_prompt_widget)
    cfp_layout.setContentsMargins(0, 0, 0, 0)
    keys_label = QLabel("Available Keys: {game_title}, {character_context}, {dialogue_context}, {prompt_to_use}, {sentence}")
    keys_label.setWordWrap(True)
    keys_label.setStyleSheet("color: #888;")
    cfp_layout.addWidget(keys_label)
    cfp_layout.addWidget(window.custom_full_prompt_textedit)
    prompt_help_button = QPushButton("Open Prompt Template Builder")
    prompt_help_button.clicked.connect(window.show_prompt_help_dialog)
    cfp_layout.addWidget(prompt_help_button)
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "ai",
            "custom_full_prompt",
            default_tooltip="Optional: Overrides the entire prompt template. Use placeholders like {sentence}.",
        ),
        custom_full_prompt_widget,
    )

    layout.addRow(window._create_reset_button("ai", window._create_ai_tab))
    return widget
