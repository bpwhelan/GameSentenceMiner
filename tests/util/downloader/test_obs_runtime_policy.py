import json

import pytest

from GameSentenceMiner.util.downloader import download_tools


def test_prune_obs_33_preserves_required_browser_and_websocket_modules(tmp_path):
    browser = tmp_path / "core" / "obs-browser"
    browser.mkdir(parents=True)
    (browser / "libcef.dll").write_bytes(b"browser")
    websocket = tmp_path / "core" / "obs-websocket" / "obs-websocket.dll"
    websocket.parent.mkdir()
    websocket.write_bytes(b"keep")
    download_tools.prune_obs_directory(str(tmp_path))
    assert (browser / "libcef.dll").read_bytes() == b"browser"
    assert websocket.read_bytes() == b"keep"


@pytest.mark.parametrize("version, suffix", [(None, "latest"), ("33.0.1", "tags/33.0.1")])
def test_obs_release_policy_selects_latest_or_exact_tag(tmp_path, version, suffix):
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"version": version}), encoding="utf-8")
    assert download_tools.get_obs_release_api_url(str(policy)).endswith("/" + suffix)


def test_obs_release_policy_rejects_invalid_version(tmp_path):
    policy = tmp_path / "policy.json"
    policy.write_text('{"version": "latest"}', encoding="utf-8")
    with pytest.raises(ValueError):
        download_tools.get_obs_release_api_url(str(policy))
