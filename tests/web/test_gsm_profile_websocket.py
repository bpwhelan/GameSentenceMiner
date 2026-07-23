from types import SimpleNamespace

from GameSentenceMiner.web.gsm_websocket import build_gsm_profile_state_payload


def test_build_gsm_profile_state_payload_serializes_current_profile_and_scenes():
    master_config = SimpleNamespace(
        current_profile="Visual Novel",
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Visual Novel": SimpleNamespace(scenes=["Game", " Reading ", ""]),
        },
    )

    assert build_gsm_profile_state_payload(master_config) == {
        "type": "gsm-profile-state-updated",
        "currentProfileName": "Visual Novel",
        "profiles": [
            {"name": "Default", "scenes": []},
            {"name": "Visual Novel", "scenes": ["Game", "Reading"]},
        ],
    }


def test_build_gsm_profile_state_payload_falls_back_to_available_profile():
    master_config = SimpleNamespace(
        current_profile="Missing",
        configs={"Default": SimpleNamespace(scenes=["Fallback"])},
    )

    payload = build_gsm_profile_state_payload(master_config)

    assert payload["currentProfileName"] == "Default"
    assert payload["profiles"] == [{"name": "Default", "scenes": ["Fallback"]}]
