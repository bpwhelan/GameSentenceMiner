import os
import subprocess
from types import SimpleNamespace

import pytest

from GameSentenceMiner.obs import launch as obs_launch
from GameSentenceMiner.ocr.ocrconfig import OCRConfig
from GameSentenceMiner.owocr.owocr.config import Config as OWOCRConfig
from GameSentenceMiner.util import gsm_utils
from GameSentenceMiner.util.command_line import split_command_line
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.media.ffmpeg import FFmpegHelper

WINDOWS_PATHS = [
    rf"C:\Users\{name}\Videos\GSM"
    for name in ("Sam", "Naicha", "nora", "rory", "tom", "bob", "fran", "日本語", "O'Brien %TEMP% & $1 [日本語]")
] + [r"\\server\share\Sam\GSM", r"\\?\C:\Users\Sam\GSM"]


@pytest.mark.parametrize("value", WINDOWS_PATHS)
@pytest.mark.skipif(os.name != "nt", reason="Windows path resolution")
def test_path_normalization_preserves_literal_names(value):
    assert configuration.sanitize_and_resolve_path(value) == value.replace("\\", "/")


@pytest.mark.parametrize("value", WINDOWS_PATHS + ["", 'a"b', "C:\\trailing space\\", "\\\\server\\share with space\\"])
@pytest.mark.skipif(os.name != "nt", reason="Windows command-line quoting")
def test_windows_command_line_preserves_arguments_using_standard_encoder(value):
    arguments = ["--path", value, "--portable"]
    assert split_command_line(subprocess.list2cmdline(arguments)) == arguments


@pytest.mark.parametrize("value", WINDOWS_PATHS)
def test_ocr_ini_readers_preserve_literal_paths(tmp_path, value):
    config_path = tmp_path / "ocr.ini"
    config_path.write_text(f"[screenai]\nresources_dir = {value}\n", encoding="utf-8")

    assert OCRConfig(config_path).get_value("screenai", "resources_dir") == value
    assert OWOCRConfig(False, config_path).get_engine("screenai")["resources_dir"] == value


def test_ocr_ini_editor_round_trips_percent_and_unicode_paths(tmp_path):
    config_path = tmp_path / "ocr.ini"
    value = WINDOWS_PATHS[8]
    config = OCRConfig(config_path)
    config.set_value("screenai", "resources_dir", value)
    config.save_config()

    assert OCRConfig(config_path).get_value("screenai", "resources_dir") == value
    assert OWOCRConfig(False, config_path).get_engine("screenai")["resources_dir"] == value


@pytest.mark.parametrize("name", ["José", "日本語"])
def test_ocr_ini_readers_accept_old_locale_encoded_files(tmp_path, name):
    config_path = tmp_path / "ocr.ini"
    value = rf"C:\Users\{name}\OCR %TEMP%"
    try:
        config_path.write_text(f"[screenai]\nresources_dir = {value}\n", encoding="locale")
    except UnicodeEncodeError:
        pytest.skip("This name cannot be represented in the system's legacy encoding")

    config = OCRConfig(config_path)
    assert config.get_value("screenai", "resources_dir") == value
    assert OWOCRConfig(False, config_path).get_engine("screenai")["resources_dir"] == value
    config.save_config()
    assert value in config_path.read_text(encoding="utf-8")


@pytest.mark.parametrize("shell", [False, True])
def test_external_audio_tool_receives_literal_paths(monkeypatch, shell):
    executable = WINDOWS_PATHS[8] + r"\Audio Editor.exe"
    audio_path = WINDOWS_PATHS[8] + r"\日本語 [1].opus"
    calls = []
    monkeypatch.setattr(
        gsm_utils, "get_config", lambda: SimpleNamespace(audio=SimpleNamespace(external_tool=executable))
    )
    monkeypatch.setattr(gsm_utils.subprocess, "Popen", lambda *args, **kwargs: calls.append((args, kwargs)))

    gsm_utils.open_audio_in_external(audio_path, shell=shell)

    assert calls == [(([executable, audio_path],), {})]


@pytest.mark.skipif(os.name != "nt", reason="Windows command-line quoting")
@pytest.mark.parametrize("quoted", [False, True])
def test_obs_command_with_arguments_preserves_windows_backslashes(monkeypatch, quoted):
    executable = r"C:\Users\Sam\OBS\obs64.exe"
    command = f'"{executable}" --portable' if quoted else f"{executable} --portable"
    monkeypatch.setattr(obs_launch.os.path, "exists", lambda path: path == executable)
    monkeypatch.setattr(obs_launch.shutil, "which", lambda _path: None)

    assert obs_launch._resolve_obs_launch_command(command) == ([executable, "--portable"], os.path.dirname(executable))


@pytest.mark.skipif(os.name != "nt", reason="Windows command-line quoting")
def test_ffmpeg_custom_options_preserve_quoted_paths_and_empty_arguments():
    arguments = ["-hwaccel", "cuda", "-filter_script:v", WINDOWS_PATHS[8] + r"\filter [1].txt", "-metadata", ""]

    before, after = FFmpegHelper.parse_custom_settings(subprocess.list2cmdline(arguments))

    assert before == arguments[:2]
    assert after == arguments[2:]


def test_ffmpeg_hwaccel_word_inside_path_is_not_an_option():
    before, after = FFmpegHelper.parse_custom_settings('-filter_script:v "C:/Sam/my -hwaccel file.txt" -c:v libx264')

    assert before == []
    assert after == ["-filter_script:v", "C:/Sam/my -hwaccel file.txt", "-c:v", "libx264"]
