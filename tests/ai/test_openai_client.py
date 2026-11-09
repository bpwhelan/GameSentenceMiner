from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.ai.contracts import AIError, AIRequest, AIResponse
from GameSentenceMiner.ai.providers.openai_client import OpenAIClient
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import AI_GEMINI, AI_LM_STUDIO, AI_OPENAI, Ai, General


def _client():
    client = object.__new__(OpenAIClient)
    client.logger = logging.getLogger(__name__)
    client.client = Mock()
    client.client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="Hello"))], usage=None
    )
    return client


@pytest.mark.parametrize("model", ["gpt-6.1-terra", "gpt-6-luna", "gpt-5-mini"])
@pytest.mark.parametrize("effort", ["none", "low", "medium", "high", "xhigh", "max"])
def test_openai_sends_reasoning_effort_without_unsupported_sampling_parameters(model, effort):
    client = _client()
    request = AIRequest(AI_OPENAI, model, "Translate", 0.3, 0.9, 4096, reasoning_effort=effort)

    assert client.generate(request).text == "Hello"

    client.client.chat.completions.create.assert_called_once()
    kwargs = client.client.chat.completions.create.call_args.kwargs
    assert kwargs["reasoning_effort"] == effort
    assert kwargs["model"] == model
    assert kwargs["messages"][1]["content"] == "Translate"
    assert not {"temperature", "top_p", "max_tokens"} & kwargs.keys()


@pytest.mark.parametrize("model", ["gpt-6.1-terra", "gpt-6-luna", "gpt-4o-mini", "local-model"])
def test_openai_model_default_omits_reasoning_effort(model):
    client = _client()
    client.generate(AIRequest(AI_OPENAI, model, "Translate", 0.3, 0.9, 4096))
    assert "reasoning_effort" not in client.client.chat.completions.create.call_args.kwargs


def test_openai_parameter_fallback_preserves_explicit_reasoning_effort():
    client = _client()
    create = client.client.chat.completions.create
    create.side_effect = [ValueError("Unsupported temperature"), create.return_value]
    request = AIRequest(AI_OPENAI, "compatible-model", "Translate", 0.3, 0.9, 4096, reasoning_effort="low")

    assert client.generate(request).text == "Hello"

    assert create.call_count == 2
    assert all(call.kwargs["reasoning_effort"] == "low" for call in create.call_args_list)
    assert "temperature" in create.call_args_list[0].kwargs
    assert "temperature" not in create.call_args_list[1].kwargs


def test_openai_does_not_silently_drop_a_rejected_reasoning_effort():
    client = _client()
    create = client.client.chat.completions.create
    create.side_effect = ValueError("Unsupported reasoning_effort")

    with pytest.raises(AIError, match="Unsupported reasoning_effort"):
        client.generate(AIRequest(AI_OPENAI, "gpt-6-luna", "Translate", 0.3, 0.9, 4096, reasoning_effort="max"))

    create.assert_called_once()


@pytest.mark.parametrize("request_kind", ["translation", "overlay_translation", "sentence", "raw"])
def test_openai_service_preserves_effort_for_primary_and_backup(request_kind):
    config = Ai(
        provider=AI_OPENAI,
        open_ai_model="gpt-6.1-terra",
        open_ai_backup_model="gpt-6-luna",
        open_ai_reasoning_effort="high",
    )
    client = Mock()
    client.generate.side_effect = [
        AIError("Primary failed"),
        AIResponse(AI_OPENAI, "gpt-6-luna", "Hello", "Hello", 1),
    ]
    registry = Mock()
    registry.get_client.return_value = client
    service = AIService(snapshot_config(config, General()), logging.getLogger(__name__), registry)
    request = service._make_request("Translate", request_kind)

    assert request.reasoning_effort == "high"
    assert service._execute_request(request).text == "Hello"
    requests = [call.args[0] for call in client.generate.call_args_list]
    assert [request.model for request in requests] == ["gpt-6.1-terra", "gpt-6-luna"]
    assert [request.reasoning_effort for request in requests] == ["high", "high"]


@pytest.mark.parametrize("provider, effort", [(AI_OPENAI, ""), (AI_GEMINI, "high"), (AI_LM_STUDIO, "low")])
def test_service_omits_openai_effort_for_default_and_other_providers(provider, effort):
    config = Ai(provider=provider, open_ai_reasoning_effort=effort)
    service = AIService(snapshot_config(config, General()), logging.getLogger(__name__), Mock())
    assert service._make_request("Translate", "translation").reasoning_effort is None
