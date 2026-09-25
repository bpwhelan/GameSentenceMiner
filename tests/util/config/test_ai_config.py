from __future__ import annotations

import pytest

from GameSentenceMiner.ai.ai_prompting import ai_config_changed
from GameSentenceMiner.ui.config.services.ai_models import RECOMMENDED_GROQ_MODELS, AIModelFetcher
from GameSentenceMiner.util.config.configuration import (
    AI_GEMINI,
    AI_GROQ,
    AI_LM_STUDIO,
    AI_OLLAMA,
    AI_OPENAI,
    Ai,
    normalize_gemini_model_name,
)


def test_ai_normalizes_gemini_3_aliases():
    cfg = Ai(
        provider=AI_GEMINI,
        gemini_model="gemini-3-flash",
        gemini_backup_model="gemini-3-pro",
        gemini_api_key="test-key",
    )

    assert cfg.gemini_model == "gemini-3-flash-preview"
    assert cfg.gemini_backup_model == "gemini-3-pro-preview"


def test_gemini_defaults_use_flash_lite_primary_and_gemma_4_backup():
    for cfg in (Ai(), Ai.from_dict({})):
        assert cfg.gemini_model == "gemini-3.5-flash-lite"
        assert cfg.gemini_backup_model == "gemma-4-31b-it"
    assert Ai(gemini_backup_model="RECOMMENDED").gemini_backup_model == "gemma-4-31b-it"


@pytest.mark.parametrize(
    "legacy_model",
    [
        "gemini-2.0-flash",
        "gemini-2.0-flash-001",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash-thinking-exp-01-21",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash-lite-preview-06-17",
        " GEMINI-2.5-FLASH ",
        " models/gemini-2.5-flash ",
    ],
)
@pytest.mark.parametrize("field", ["gemini_model", "gemini_backup_model"])
def test_saved_gemini_2_models_upgrade_to_flash_lite(legacy_model, field):
    values = {
        "gemini_model": "gemini-3-pro-preview",
        "gemini_backup_model": "gemma-4-31b-it",
        field: legacy_model,
    }
    cfg = Ai.from_dict(values)

    assert getattr(cfg, field) == "gemini-3.5-flash-lite"
    assert Ai.from_dict(cfg.to_dict()) == cfg
    assert normalize_gemini_model_name(legacy_model) == "gemini-3.5-flash-lite"


@pytest.mark.parametrize("primary", ["gemini-2.5-flash", "gemini-3.5-flash-lite"])
def test_gemini_migration_keeps_a_distinct_backup(primary):
    cfg = Ai.from_dict({"gemini_model": primary, "gemini_backup_model": "gemini-2.0-flash"})

    assert cfg.gemini_model == "gemini-3.5-flash-lite"
    assert cfg.gemini_backup_model == "gemma-4-31b-it"


@pytest.mark.parametrize("backup", ["", "OFF", None])
def test_gemini_migration_preserves_explicitly_disabled_backup(backup):
    cfg = Ai.from_dict({"gemini_model": "gemini-2.5-flash", "gemini_backup_model": backup})

    assert cfg.gemini_model == "gemini-3.5-flash-lite"
    assert cfg.gemini_backup_model == ""


@pytest.mark.parametrize("model", ["gemini-3.5-flash-lite", "gemini-3-pro-preview", "gemma-2-27b-it", "gemma-4-31b-it"])
def test_gemini_migration_keeps_other_models(model):
    assert normalize_gemini_model_name(model) == model


def test_ai_clears_backup_model_when_same_as_primary():
    cfg = Ai(
        provider=AI_GEMINI,
        gemini_model="gemma-3-27b-it",
        gemini_backup_model="gemma-3-27b-it",
        gemini_api_key="test-key",
    )

    assert cfg.gemini_backup_model == ""


def test_groq_defaults_use_gpt_oss_primary_and_backup():
    cfg = Ai(provider=AI_GROQ)

    assert cfg.groq_model == "openai/gpt-oss-120b"
    assert cfg.groq_backup_model == "openai/gpt-oss-20b"
    assert Ai(groq_model="RECOMMENDED").groq_model == cfg.groq_model
    assert Ai(groq_backup_model="RECOMMENDED").groq_backup_model == cfg.groq_backup_model
    assert Ai(groq_backup_model="OFF").groq_backup_model == ""


def test_groq_recommendations_only_include_current_production_text_models():
    expected = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]

    assert RECOMMENDED_GROQ_MODELS == expected
    assert AIModelFetcher("")._get_groq_models() == ["RECOMMENDED", *expected, "OTHER"]


def test_ai_config_changed_detects_gemini_backup_model_updates():
    current = Ai(
        provider=AI_GEMINI,
        gemini_model="gemini-2.5-flash",
        gemini_backup_model="gemma-3-27b-it",
        gemini_api_key="test-key",
    )
    updated = Ai(
        provider=AI_GEMINI,
        gemini_model="gemini-2.5-flash",
        gemini_backup_model="gemma-3-12b-it",
        gemini_api_key="test-key",
    )

    assert ai_config_changed(updated, current) is True


@pytest.mark.parametrize(
    ("provider", "current_kwargs", "updated_kwargs"),
    [
        (
            AI_GROQ,
            {
                "groq_model": "llama-3.1-8b-instant",
                "groq_backup_model": "qwen/qwen3-32b",
                "groq_api_key": "k",
            },
            {
                "groq_model": "llama-3.1-8b-instant",
                "groq_backup_model": "openai/gpt-oss-120b",
                "groq_api_key": "k",
            },
        ),
        (
            AI_OPENAI,
            {
                "open_ai_url": "https://api.example.com/v1",
                "open_ai_model": "gpt-4o-mini",
                "open_ai_backup_model": "gpt-4.1-mini",
                "open_ai_api_key": "k",
            },
            {
                "open_ai_url": "https://api.example.com/v1",
                "open_ai_model": "gpt-4o-mini",
                "open_ai_backup_model": "gpt-4.1-nano",
                "open_ai_api_key": "k",
            },
        ),
        (
            AI_OLLAMA,
            {
                "ollama_url": "http://localhost:11434",
                "ollama_model": "llama3",
                "ollama_backup_model": "qwen2.5",
            },
            {
                "ollama_url": "http://localhost:11434",
                "ollama_model": "llama3",
                "ollama_backup_model": "mistral",
            },
        ),
        (
            AI_LM_STUDIO,
            {
                "lm_studio_url": "http://localhost:1234/v1",
                "lm_studio_model": "mistral-small",
                "lm_studio_backup_model": "qwen2.5",
                "lm_studio_api_key": "lm-studio",
            },
            {
                "lm_studio_url": "http://localhost:1234/v1",
                "lm_studio_model": "mistral-small",
                "lm_studio_backup_model": "llama-3.1-8b",
                "lm_studio_api_key": "lm-studio",
            },
        ),
    ],
)
def test_ai_config_changed_detects_backup_model_updates_for_all_providers(provider, current_kwargs, updated_kwargs):
    current = Ai(provider=provider, **current_kwargs)
    updated = Ai(provider=provider, **updated_kwargs)
    assert ai_config_changed(updated, current) is True


def test_ai_clears_non_gemini_backup_model_when_same_as_primary():
    groq_cfg = Ai(
        provider=AI_GROQ,
        groq_model="llama-3.1-8b-instant",
        groq_backup_model="llama-3.1-8b-instant",
        groq_api_key="k",
    )
    openai_cfg = Ai(
        provider=AI_OPENAI,
        open_ai_url="https://api.example.com/v1",
        open_ai_model="gpt-4o-mini",
        open_ai_backup_model="gpt-4o-mini",
        open_ai_api_key="k",
    )
    ollama_cfg = Ai(
        provider=AI_OLLAMA,
        ollama_url="http://localhost:11434",
        ollama_model="llama3",
        ollama_backup_model="llama3",
    )
    lm_cfg = Ai(
        provider=AI_LM_STUDIO,
        lm_studio_url="http://localhost:1234/v1",
        lm_studio_model="mistral-small",
        lm_studio_backup_model="mistral-small",
        lm_studio_api_key="lm-studio",
    )

    assert groq_cfg.groq_backup_model == ""
    assert openai_cfg.open_ai_backup_model == ""
    assert ollama_cfg.ollama_backup_model == ""
    assert lm_cfg.lm_studio_backup_model == ""
