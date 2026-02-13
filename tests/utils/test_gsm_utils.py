import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta
from types import ModuleType, SimpleNamespace

import pytest

rapidfuzz_stub = ModuleType("rapidfuzz")
rapidfuzz_stub.process = SimpleNamespace()
sys.modules.setdefault("rapidfuzz", rapidfuzz_stub)

try:
    from GameSentenceMiner.util import gsm_utils
except ModuleNotFoundError as exc:
    if exc.name != "rapidfuzz":
        raise
    sys.modules["rapidfuzz"] = rapidfuzz_stub
    from GameSentenceMiner.util import gsm_utils



@pytest.fixture
def stub_config(monkeypatch):
    config = SimpleNamespace(
        advanced=SimpleNamespace(multi_line_line_break="|"),
        features=SimpleNamespace(generate_longplay=True),
        audio=SimpleNamespace(external_tool="tool.exe"),
    )
    monkeypatch.setattr(gsm_utils, "get_config", lambda: config)
    return config


def test_time_it_returns_value(monkeypatch):
    def _fn(a, b):
        return a + b

    result = gsm_utils.time_it(_fn, 2, 3)
    assert result == 5


def test_run_new_thread_executes():
    done = threading.Event()

    def _fn():
        done.set()

    thread = gsm_utils.run_new_thread(_fn)
    thread.join(timeout=1)
    assert done.is_set()
    assert thread.daemon


def test_get_unique_temp_file_for_game_uses_temp_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(gsm_utils, "get_temporary_directory", lambda: str(tmp_path))
    path = gsm_utils.get_unique_temp_file_for_game("My/Game:Name", "wav")
    assert str(tmp_path) in path
    assert path.endswith(".wav")
    assert "MyGameName" in os.path.basename(path)


def test_make_unique_temp_file(monkeypatch, tmp_path):
    monkeypatch.setattr(gsm_utils, "get_temporary_directory", lambda: str(tmp_path))
    path = gsm_utils.make_unique_temp_file(tmp_path / "audio.mp3")
    assert str(tmp_path) in path
    assert path.endswith(".mp3")
    assert "audio_" in os.path.basename(path)


def test_make_unique_file_name(tmp_path):
    path = gsm_utils.make_unique_file_name(tmp_path / "image.png")
    assert str(tmp_path) in path
    assert path.endswith(".png")
    assert "image_" in os.path.basename(path)


def test_make_unique_prefix():
    value = gsm_utils.make_unique("prefix")
    assert value.startswith("prefix_")
    assert re.search(r"\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}$", value)


def test_sanitize_filename():
    assert gsm_utils.sanitize_filename("a<b>:c|d") == "abcd"


def test_get_random_digit_string():
    value = gsm_utils.get_random_digit_string()
    assert len(value) == 9
    assert value.isdigit()


def test_timedelta_to_ffmpeg_friendly_format():
    td = timedelta(hours=1, minutes=2, seconds=3.456)
    assert gsm_utils.timedelta_to_ffmpeg_friendly_format(td) == "01:02:03.456"


def test_get_file_modification_time(tmp_path):
    target = tmp_path / "file.txt"
    target.write_text("x", encoding="utf-8")
    ts = datetime(2020, 1, 1, 0, 0, 0).timestamp()
    os.utime(target, (ts, ts))
    mod_time = gsm_utils.get_file_modification_time(str(target))
    assert mod_time == datetime.fromtimestamp(ts)


def test_remove_html_and_cloze_tags():
    text = "Hello <b>world</b> {{c1::test::hint}} [migaku]"
    assert gsm_utils.remove_html_and_cloze_tags(text) == "Hello world test "


def test_combine_dialogue_empty_returns_list():
    assert gsm_utils.combine_dialogue([]) == []


def test_combine_dialogue_single_line_no_separator():
    assert gsm_utils.combine_dialogue(["plain line"]) == ["plain line"]


def test_combine_dialogue_merges_lines(stub_config):
    lines = ["キャラA「first」", "キャラA「second」", "キャラB「other」"]
    result = gsm_utils.combine_dialogue(lines)
    assert result == ["キャラA「first|second」|", "キャラB「other」"]


def test_wait_for_stable_file_true(tmp_path):
    target = tmp_path / "stable.txt"
    target.write_text("ok", encoding="utf-8")
    assert gsm_utils.wait_for_stable_file(str(target), timeout=0.5, check_interval=0.05)


def test_wait_for_stable_file_false(tmp_path):
    missing = tmp_path / "missing.txt"
    assert not gsm_utils.wait_for_stable_file(str(missing), timeout=0.2, check_interval=0.05)


def test_isascii():
    assert gsm_utils.isascii("abc123")
    assert not gsm_utils.isascii("日本語")


def test_do_text_replacements(tmp_path):
    config = {
        "enabled": True,
        "args": {
            "replacements": {
                "hello": "hi",
                "re:cat+": "dog",
                "縲・": "-",
            }
        },
    }
    replacements_path = tmp_path / "replacements.json"
    replacements_path.write_text(json.dumps(config), encoding="utf-8")
    text = "hello cattt 縲・"
    result = gsm_utils.do_text_replacements(text, str(replacements_path))
    assert result == "hi dog -"


def test_open_audio_in_external_calls_popen(monkeypatch, stub_config):
    calls = []

    def fake_popen(args, shell=False):
        calls.append((args, shell))
        return None

    monkeypatch.setattr(gsm_utils.subprocess, "Popen", fake_popen)
    gsm_utils.open_audio_in_external("c:/audio.mp3")
    assert calls == [(["tool.exe", "c:/audio.mp3"], False)]


def test_is_connected_true(monkeypatch):
    def fake_conn(*_args, **_kwargs):
        return object()

    monkeypatch.setattr(gsm_utils.socket, "create_connection", fake_conn)
    assert gsm_utils.is_connected()


def test_is_connected_false(monkeypatch):
    def fake_conn(*_args, **_kwargs):
        raise OSError("no")

    monkeypatch.setattr(gsm_utils.socket, "create_connection", fake_conn)
    assert not gsm_utils.is_connected()


def test_add_srt_line_writes_file(monkeypatch, tmp_path, stub_config):
    srt_path = tmp_path / "out.srt"
    start = datetime(2020, 1, 1, 0, 0, 0)
    prev_time = start + timedelta(seconds=1)
    line_time = start + timedelta(seconds=3)

    class Prev:
        def __init__(self, text, time_value):
            self.text = text
            self.time = time_value

    class Line:
        def __init__(self, prev):
            self.prev = prev

    prev = Prev("hello", prev_time)
    line = Line(prev)

    gsm_utils.gsm_state.recording_started_time = start
    gsm_utils.gsm_state.current_srt = str(srt_path)
    gsm_utils.gsm_state.srt_index = 1

    gsm_utils.add_srt_line(line_time, line)

    content = srt_path.read_text(encoding="utf-8")
    assert "1" in content
    assert "-->" in content
    assert "hello" in content
    assert gsm_utils.gsm_state.srt_index == 2


@pytest.mark.parametrize(
    "case",
    [
                {
            "name": "single-tag",
            "original": "フィンガーズ：おい君、この<b>猛獣</b>を黙らせるか寝かしつけるかしてくれ。こんないたらまともに話もできない",
            "new": "フィンガーズ：おい君、この猛獣を黙らせるか寝かしつけるかしてくれ。こんないたらまともに話もできない",
            "expected": "フィンガーズ：おい君、この<b>猛獣</b>を黙らせるか寝かしつけるかしてくれ。こんないたらまともに話もできない",
        },
        {
            "name": "nested-tags",
            "original": "これは<b><i>重要</i></b>です。",
            "new": "これは重要です。",
            "expected": "これは<b><i>重要</i></b>です。",
        },
        {
            "name": "attributes",
            "original": "ここは<span class='x' data-y='1'><b>強</b>調</span>だ。",
            "new": "ここは強調だ。",
            "expected": "ここは<span class='x' data-y='1'><b>強</b>調</span>だ。",
        },
        {
            "name": "multiple-spans",
            "original": "<b>前</b>と<b>後</b>。",
            "new": "前と後。",
            "expected": "<b>前</b>と<b>後</b>。",
        },
        {
            "name": "void-br-preserved",
            "original": "前<br>後",
            "new": "前後",
            "expected": "前<br>後",
        },
        {
            "name": "void-br-ordered-with-bold",
            "original": "A<br><b>B</b>C",
            "new": "ABC",
            "expected": "A<br><b>B</b>C",
        },
        {
            "name": "cloze-basic",
            "original": "これは{重要}です。",
            "new": "これは重要です。",
            "expected": "これは{重要}です。",
        },
        {
            "name": "cloze-nested-html",
            "original": "これは{<b>重要</b>}です。",
            "new": "これは重要です。",
            "expected": "これは{<b>重要</b>}です。",
        },
        {
            "name": "html-nested-cloze",
            "original": "これは<b>{重要}</b>です。",
            "new": "これは重要です。",
            "expected": "これは<b>{重要}</b>です。",
        },
        {
            "name": "multiple-clozes",
            "original": "これは{重要}で{必要}です。",
            "new": "これは重要で必要です。",
            "expected": "これは{重要}で{必要}です。",
        },
        {
            "name": "cloze-with-hint",
            "original": "これは{{c1::重要::hint}}です。",
            "new": "これは重要です。",
            "expected": "これは{{c1::重要::hint}}です。",
        },
        {
            "name": "multiple-numbered-clozes",
            "original": "{{c1::一つ}}と{{c2::二つ}}です。",
            "new": "一つと二つです。",
            "expected": "{{c1::一つ}}と{{c2::二つ}}です。",
        },
        {
            "name": "deeply-nested-cloze-html",
            "original": "<div><span>{<b><i>重要</i></b>}</span></div>",
            "new": "重要",
            "expected": "<div><span>{<b><i>重要</i></b>}</span></div>",
        },
        {
            "name": "multiple-identical-words-first-cloze",
            "original": "猫は{猫}です。猫は動物。",
            "new": "猫は猫です。猫は動物。",
            "expected": "猫は{猫}です。猫は動物。",
        },
        {
            "name": "multiple-identical-words-middle-cloze",
            "original": "猫は猫{です}。猫は動物。",
            "new": "猫は猫です。猫は動物。",
            "expected": "猫は猫{です}。猫は動物。",
        },
        {
            "name": "multiple-identical-all-cloze",
            "original": "{猫}は{猫}です。{猫}は動物。",
            "new": "猫は猫です。猫は動物。",
            "expected": "{猫}は{猫}です。{猫}は動物。",
        },
        {
            "name": "identical-words-partial-tag",
            "original": "力は<b>力</b>なり。力は大切。",
            "new": "力は力なり。力は大切。",
            "expected": "力は<b>力</b>なり。力は大切。",
        },
        {
            "name": "identical-words-all-tagged",
            "original": "<b>力</b>は<b>力</b>なり。<b>力</b>は大切。",
            "new": "力は力なり。力は大切。",
            "expected": "<b>力</b>は<b>力</b>なり。<b>力</b>は大切。",
        },
        {
            "name": "identical-words-cloze-and-tag",
            "original": "{猫}は<b>猫</b>です。",
            "new": "猫は猫です。",
            "expected": "{猫}は<b>猫</b>です。",
        },
        {
            "name": "repeated-word-different-contexts",
            "original": "美しい{美しい}。また{美しい}日。",
            "new": "美しい美しい。また美しい日。",
            "expected": "美しい{美しい}。また{美しい}日。",
        },
        {
            "name": "identical-numbered-clozes",
            "original": "{{c1::test}}と{{c1::test}}。",
            "new": "testとtest。",
            "expected": "{{c1::test}}と{{c1::test}}。",
        },
        {
            "name": "mismatch-keeps-html-on-matching-segment",
            "original": "これは<b>重要</b>です。",
            "new": "ところでこれは重要です！",
            "expected": "ところでこれは<b>重要</b>です！",
        },
        {
            "name": "mismatch-keeps-cloze-on-matching-segment",
            "original": "今日は{{c1::雨::あめ}}です。",
            "new": "明日も雨です。",
            "expected": "明日も{{c1::雨::あめ}}です。",
        },
        {
            "name": "mismatch-keeps-nested-html-on-matching-word",
            "original": "A <span class='x'><b>cat</b></span> B",
            "new": "A very cat B",
            "expected": "A very <span class='x'><b>cat</b></span> B",
        },
    ],
    ids=lambda case: case["name"],
)

def test_preserve_html_tags(case):
    result = gsm_utils.preserve_html_tags(case["original"], case["new"])
    assert result == case["expected"]


def test_do_text_replacements_empty_text():
    assert gsm_utils.do_text_replacements("", "fake.json") == ""


def test_do_text_replacements_missing_file(tmp_path):
    missing = tmp_path / "missing.json"
    assert gsm_utils.do_text_replacements("hello", str(missing)) == "hello"


def test_do_text_replacements_disabled(tmp_path):
    config = {"enabled": False, "args": {"replacements": {"hello": "hi"}}}
    replacements_path = tmp_path / "replacements.json"
    replacements_path.write_text(json.dumps(config), encoding="utf-8")
    assert gsm_utils.do_text_replacements("hello", str(replacements_path)) == "hello"


def test_do_text_replacements_invalid_regex(tmp_path):
    config = {
        "enabled": True,
        "args": {"replacements": {"re:[invalid": "replacement"}},
    }
    replacements_path = tmp_path / "replacements.json"
    replacements_path.write_text(json.dumps(config), encoding="utf-8")
    result = gsm_utils.do_text_replacements("test", str(replacements_path))
    assert result == "test"


def test_combine_dialogue_different_characters(stub_config):
    lines = ["キャラA「line1」", "キャラB「line2」", "キャラC「line3」"]
    result = gsm_utils.combine_dialogue(lines)
    assert len(result) == 3


def test_combine_dialogue_single_character_multiple_lines(stub_config):
    lines = ["キャラA「line1」", "キャラA「line2」", "キャラA「line3」"]
    result = gsm_utils.combine_dialogue(lines)
    assert len(result) == 1
    assert "line1|line2|line3" in result[0]


def test_sanitize_filename_already_clean():
    assert gsm_utils.sanitize_filename("cleanname.txt") == "cleanname.txt"


def test_sanitize_filename_all_special_chars():
    assert gsm_utils.sanitize_filename('<>:"/\\|?*') == ""


def test_remove_html_and_cloze_tags_empty():
    assert gsm_utils.remove_html_and_cloze_tags("") == ""


def test_remove_html_and_cloze_tags_plain_text():
    assert gsm_utils.remove_html_and_cloze_tags("plain text") == "plain text"


def test_remove_html_and_cloze_tags_complex():
    text = "<b>Bold</b> {{c1::cloze}} [migaku] normal"
    assert gsm_utils.remove_html_and_cloze_tags(text) == "Bold cloze  normal"


def test_preserve_html_tags_no_tags():
    original = "plain text"
    new = "plain text"
    assert gsm_utils.preserve_html_tags(original, new) == "plain text"


def test_preserve_html_tags_mismatch_warns(stub_config):
    original = "<b>different</b>"
    new = "completely unrelated"
    result = gsm_utils.preserve_html_tags(original, new)
    assert result == "completely unrelated"


def test_open_audio_in_external_with_shell(monkeypatch, stub_config):
    calls = []

    def fake_popen(cmd, shell=False):
        calls.append((cmd, shell))
        return None

    monkeypatch.setattr(gsm_utils.subprocess, "Popen", fake_popen)
    gsm_utils.open_audio_in_external("c:/audio.mp3", shell=True)
    assert calls[0][1] is True


def test_wait_for_stable_file_becomes_stable(tmp_path):
    target = tmp_path / "stable.txt"
    target.write_text("initial", encoding="utf-8")
    time.sleep(0.1)
    assert gsm_utils.wait_for_stable_file(str(target), timeout=1, check_interval=0.05)


def test_time_it_preserves_kwargs():
    def _fn(a, b, c=10):
        return a + b + c

    result = gsm_utils.time_it(_fn, 1, 2, c=20)
    assert result == 23


def test_make_unique_file_name_creates_new_path(tmp_path):
    original = tmp_path / "test.txt"
    unique = gsm_utils.make_unique_file_name(original)
    assert str(tmp_path) in unique
    assert "test_" in unique
    assert unique.endswith(".txt")
    assert unique != str(original)


def test_timedelta_to_ffmpeg_friendly_format_zero():
    td = timedelta(seconds=0)
    assert gsm_utils.timedelta_to_ffmpeg_friendly_format(td) == "00:00:00.000"


def test_timedelta_to_ffmpeg_friendly_format_large():
    td = timedelta(hours=25, minutes=70, seconds=90.5)
    result = gsm_utils.timedelta_to_ffmpeg_friendly_format(td)
    assert result.startswith("26:")


def test_isascii_mixed():
    assert not gsm_utils.isascii("hello日本")


def test_isascii_numbers():
    assert gsm_utils.isascii("123456")


def test_isascii_special_chars():
    assert gsm_utils.isascii("!@#$%^&*()")


def test_run_new_thread_returns_thread():
    def _fn():
        time.sleep(0.01)

    thread = gsm_utils.run_new_thread(_fn)
    assert isinstance(thread, threading.Thread)
    assert thread.daemon
    thread.join(timeout=1)


def test_sanitize_filename_with_spaces():
    assert gsm_utils.sanitize_filename("file name.txt") == "filename.txt"


def test_sanitize_filename_unicode_preserved():
    # Unicode characters outside the restricted range should be preserved
    assert "日本" in gsm_utils.sanitize_filename("test日本.txt")


def test_get_random_digit_string_uniqueness():
    results = {gsm_utils.get_random_digit_string() for _ in range(100)}
    # Should generate mostly unique values
    assert len(results) > 90


def test_do_text_replacements_word_boundary_ascii(tmp_path):
    config = {
        "enabled": True,
        "args": {"replacements": {"cat": "dog"}},
    }
    replacements_path = tmp_path / "replacements.json"
    replacements_path.write_text(json.dumps(config), encoding="utf-8")
    # Word boundary should match whole words only
    result = gsm_utils.do_text_replacements("the cat sat", str(replacements_path))
    assert "dog" in result
    result2 = gsm_utils.do_text_replacements("category", str(replacements_path))
    # Should not replace within words for ASCII
    assert "dog" not in result2


def test_combine_dialogue_single_line_with_brackets():
    lines = ["キャラA「single」"]
    result = gsm_utils.combine_dialogue(lines)
    assert len(result) == 1
    assert "キャラA「single」" == result[0]


def test_preserve_html_tags_empty_new_text():
    original = "<b>test</b>"
    new = ""
    result = gsm_utils.preserve_html_tags(original, new)
    # When new text is empty, function should handle gracefully
    assert isinstance(result, str)
