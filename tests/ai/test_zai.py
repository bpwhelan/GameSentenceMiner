import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.ai.ai_prompting import ai_config_changed
from GameSentenceMiner.ai.contracts import AIError, AIRequest
from GameSentenceMiner.ai.providers.zai_client import ZaiClient
from GameSentenceMiner.ai.registry import ProviderRegistry
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import AI_ZAI, Ai, General


def test_zai_defaults_aliases_and_round_trip():
    for alias in ("z.ai", "zai", "Z.AI", "Z.ai"):
        config = Ai(provider=alias, zai_api_key="  example-key  ")
        assert config.provider == AI_ZAI
        assert config.zai_model == "glm-4.7-flash"
        assert config.zai_backup_model == ""
        assert config.zai_api_key == "example-key"
        assert config.is_configured()
        assert Ai.from_dict(config.to_dict()) == config
    assert not Ai(provider=AI_ZAI, zai_api_key=" \n").is_configured()


def test_zai_change_detection_and_duplicate_backup():
    current = Ai(provider=AI_ZAI, zai_api_key="key")
    assert ai_config_changed(Ai(provider=AI_ZAI, zai_api_key="new-key"), current)
    assert ai_config_changed(Ai(provider=AI_ZAI, zai_api_key="key", zai_model="glm-4.7"), current)
    assert Ai(provider=AI_ZAI, zai_backup_model="glm-4.7-flash").zai_backup_model == ""


def test_zai_key_follows_shared_provider_across_profiles():
    from GameSentenceMiner.util.config.configuration import Config, ProfileConfig

    config = Config(
        current_profile="Default",
        configs={
            "Default": ProfileConfig(ai=Ai(provider=AI_ZAI, zai_api_key="test-key")),
            "Game": ProfileConfig(),
        },
    )
    config.sync_shared_fields()
    assert config.configs["Game"].ai.provider == AI_ZAI
    assert config.configs["Game"].ai.zai_api_key == "test-key"
    assert config.configs["Game"].ai.is_configured()


def test_zai_uses_standard_endpoint_and_disables_thinking(monkeypatch):
    import openai

    sdk = Mock()
    sdk.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content='{"blocks":[]}'), finish_reason="stop")],
        usage=None,
    )
    constructor = Mock(return_value=sdk)
    monkeypatch.setattr(openai, "OpenAI", constructor)
    config = Ai(provider=AI_ZAI, zai_api_key="key")
    registry = ProviderRegistry(logging.getLogger(__name__))
    client = registry.get_client(config)
    assert registry.get_client(config) is client
    assert constructor.call_args.kwargs["base_url"] == "https://api.z.ai/api/paas/v4/"
    request = AIRequest(
        AI_ZAI, config.zai_model, "Return block JSON", 0.3, 0.9, 4096, request_kind="overlay_translation"
    )
    assert client.generate(request).text == '{"blocks":[]}'
    kwargs = sdk.chat.completions.create.call_args.kwargs
    assert kwargs["extra_body"] == {"thinking": {"type": "disabled"}}
    assert kwargs["max_tokens"] == 4096
    assert kwargs["messages"] == [{"role": "user", "content": request.prompt}]


def test_zai_rejects_empty_and_truncated_responses():
    client = object.__new__(ZaiClient)
    client.logger = logging.getLogger(__name__)
    client.client = Mock()
    request = AIRequest(AI_ZAI, "glm-4.7-flash", "prompt", 0.3, 0.9, 64)
    for content, reason in (("", "stop"), ("partial", "length")):
        client.client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=reason)], usage=None
        )
        with pytest.raises(AIError):
            client.generate(request)


def test_zai_service_uses_explicit_backup(monkeypatch):
    from GameSentenceMiner.ai.contracts import AIResponse

    client = Mock()
    client.generate.side_effect = [
        AIError("Rate limit", transient=True),
        AIResponse(AI_ZAI, "glm-4.5-flash", "ok", "ok", 1),
    ]
    registry = Mock()
    registry.get_client.return_value = client
    service = AIService(
        snapshot_config(Ai(provider=AI_ZAI, zai_api_key="key", zai_backup_model="glm-4.5-flash"), General()),
        logging.getLogger(__name__),
        registry,
    )
    response = service._execute_request(service._make_request("Hello", "translation"))
    assert response.text == "ok"
    assert [call.args[0].model for call in client.generate.call_args_list] == ["glm-4.7-flash", "glm-4.5-flash"]
