from __future__ import annotations

import pytest

from GameSentenceMiner.ai.ai_prompting import ai_config_changed
from GameSentenceMiner.util.config.configuration import (
    AI_GEMINI,
    AI_GROQ,
    AI_LM_STUDIO,
    AI_OLLAMA,
    AI_OPENAI,
    Ai,
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


def test_ai_clears_backup_model_when_same_as_primary():
    cfg = Ai(
        provider=AI_GEMINI,
        gemini_model="gemma-3-27b-it",
        gemini_backup_model="gemma-3-27b-it",
        gemini_api_key="test-key",
    )

    assert cfg.gemini_backup_model == ""


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
            {"groq_model": "llama-3.1-8b-instant", "groq_backup_model": "qwen/qwen3-32b", "groq_api_key": "k"},
            {"groq_model": "llama-3.1-8b-instant", "groq_backup_model": "openai/gpt-oss-120b", "groq_api_key": "k"},
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
            {"ollama_url": "http://localhost:11434", "ollama_model": "llama3", "ollama_backup_model": "qwen2.5"},
            {"ollama_url": "http://localhost:11434", "ollama_model": "llama3", "ollama_backup_model": "mistral"},
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
