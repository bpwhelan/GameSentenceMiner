import json
from pathlib import Path

from GameSentenceMiner.ui.config.i18n import load_localization
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import Config, Locale


def test_locale_accepts_desktop_locale_aliases():
    assert Locale.from_any("en") is Locale.English
    assert Locale.from_any("ja") is Locale.日本語
    assert Locale.from_any("ko") is Locale.한국어
    assert Locale.from_any("ukr") is Locale.Українська
    assert Locale.from_any("zh") is Locale.中文
    assert Locale.from_any("es") is Locale.Español


def test_python_locale_files_exist_for_desktop_languages():
    root = Path(__file__).resolve().parents[3]
    locales_dir = root / "GameSentenceMiner" / "locales"
    locale_names = ("en_us", "ja_jp", "zh_cn", "es_es", "ko_kr", "ukr_ua")

    for locale_name in locale_names:
        locale_path = locales_dir / f"{locale_name}.json"
        assert locale_path.exists()
        locale_data = json.loads(locale_path.read_text(encoding="utf-8"))
        assert locale_data["python"]["config"]["tabs"]["general"]["locale"]["label"]


def test_load_localization_supports_new_locales():
    assert load_localization(Locale.한국어)["tabs"]["general"]["locale"]["label"]
    assert load_localization(Locale.Українська)["tabs"]["general"]["locale"]["label"]


def test_load_config_reads_utf8_json_with_non_ascii_text(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    data = Config.new().to_dict()
    data["locale"] = "ukr_ua"
    data["configs"]["Default"]["scenes"] = ["もっと！", "Українська"]

    config_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = configuration.load_config()

    assert loaded.locale == "ukr_ua"
    assert loaded.configs["Default"].scenes == ["もっと！", "Українська"]
