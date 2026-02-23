import asyncio
from html.parser import HTMLParser
import json
import os
import random
import re
import socket
import string
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from rapidfuzz import process

from GameSentenceMiner.util.config.configuration import gsm_state, logger, get_config, get_app_directory, \
    get_temporary_directory

SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"

def time_it(func, *args, **kwargs):
    start_time = time.perf_counter()
    result = func(*args, **kwargs)
    end_time = time.perf_counter()
    elapsed_time = end_time - start_time
    logger.info(f"Function executed in {elapsed_time:.4f} seconds.")
    return result

def run_new_thread(func):
    thread = threading.Thread(target=func, daemon=True)
    thread.start()
    return thread

def get_unique_temp_file_for_game(game_title, suffix):
    sanitized_title = sanitize_filename(game_title)
    current_time = datetime.now().strftime('%Y-%m-%d-%H-%M-%S-%f')[:-3]
    temp_dir = get_temporary_directory()
    os.makedirs(temp_dir, exist_ok=True)
    return str(Path(temp_dir) / f"{sanitized_title}_{current_time}.{suffix}")

def make_unique_temp_file(path):
    path = Path(path)
    current_time = datetime.now().strftime('%Y-%m-%d-%H-%M-%S-%f')[:-3]
    temp_dir = get_temporary_directory()
    os.makedirs(temp_dir, exist_ok=True)
    return str(Path(temp_dir) / f"{path.stem}_{current_time}{path.suffix}")

def make_unique_file_name(path):
    path = Path(path)
    current_time = datetime.now().strftime('%Y-%m-%d-%H-%M-%S-%f')[:-3]
    return str(path.parent / f"{path.stem}_{current_time}{path.suffix}")

def make_unique(text):
    """
    Generate a unique string by appending a timestamp to the input text.
    This is useful for creating unique filenames or identifiers.
    """
    current_time = datetime.now().strftime('%Y-%m-%d-%H-%M-%S-%f')[:-3]
    return f"{text}_{current_time}"

def sanitize_filename(filename):
        return re.sub(r'[ <>:"/\\|?*\x00-\x1F]', '', filename)


def get_random_digit_string():
    return ''.join(random.choice(string.digits) for i in range(9))


def timedelta_to_ffmpeg_friendly_format(td_obj):
    total_seconds = td_obj.total_seconds()
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)


def get_file_modification_time(file_path):
    mod_time_epoch = os.path.getmtime(file_path)
    mod_time = datetime.fromtimestamp(mod_time_epoch)
    return mod_time


def remove_html_and_cloze_tags(text):
    """
    Removes HTML, Migaku, and Anki cloze tags from the input text.
    1. Removes HTML tags enclosed in <...>
    2. Removes Anki cloze tags of the form {{c1::text::hint}} or {{c1::text}}
    3. Removes Migaku tags of the form [text]
    """
    text = re.sub(r'<.*?>', '', re.sub(r'{{c\d+::(.*?)(::.*?)?}}', r'\1', re.sub(r'\[.*?\]', '', text)))
    return text


def combine_dialogue(dialogue_lines, new_lines=None):
    if not dialogue_lines:  # Handle empty input
        return []

    if new_lines is None:
        new_lines = []

    if len(dialogue_lines) == 1 and '「' not in dialogue_lines[0]:
        new_lines.append(dialogue_lines[0])
        return new_lines

    character_name = dialogue_lines[0].split("「")[0]
    text = character_name + "「"

    for i, line in enumerate(dialogue_lines):
        if not line.startswith(character_name + "「"):
            text = text + "」" + get_config().advanced.multi_line_line_break
            new_lines.append(text)
            new_lines.extend(combine_dialogue(dialogue_lines[i:]))
            break
        else:
            text +=  (get_config().advanced.multi_line_line_break if i > 0 else "") + line.split("「")[1].rstrip("」") + ""
    else:
        text = text + "」"
        new_lines.append(text)

    return new_lines

def wait_for_stable_file(file_path, timeout=10, check_interval=0.1):
    elapsed_time = 0
    last_size = -1

    while elapsed_time < timeout:
        try:
            current_size = os.path.getsize(file_path)
            if current_size == last_size:
                try:
                    with open(file_path, 'rb'):
                        return True
                except IOError:
                    pass
            last_size = current_size
        except FileNotFoundError:
            last_size = -1
        except Exception as e:
            logger.warning(f"Error checking file {file_path}, will retry: {e}")
            last_size = -1

        time.sleep(check_interval)
        elapsed_time += check_interval

    logger.warning(f"File '{file_path}' did not stabilize or become accessible within {timeout} seconds. Continuing...")
    return False

def isascii(s: str):
    try:
        return s.isascii()
    except:
        try:
            s.encode("ascii")
            return True
        except:
            return False

def do_text_replacements(text, replacements_json):
    if not text:
        return text

    replacements = {}
    if os.path.exists(replacements_json):
        with open(replacements_json, 'r', encoding='utf-8') as f:
            replacements.update(json.load(f))

    if replacements.get("enabled", False):
        orig_text = text
        filters = replacements.get("args", {}).get("replacements", {})
        for fil, replacement in filters.items():
            if not fil:
                continue
            if fil.startswith("re:"):
                pattern = fil[3:]
                try:
                    text = re.sub(pattern, replacement, text)
                except Exception:
                    logger.error(f"Invalid regex pattern: {pattern}")
                    continue
            if isascii(fil):
                text = re.sub(r"\b{}\b".format(re.escape(fil)), replacement, text)
            else:
                text = text.replace(fil, replacement)
        if text != orig_text:
            logger.info(f"Text replaced: '{orig_text}' -> '{text}' using replacements.")
    return text


def open_audio_in_external(fileabspath, shell=False):
    logger.info(f"Opening audio in external program...")
    try:
        if shell:
            subprocess.Popen(f' "{get_config().audio.external_tool}" "{fileabspath}" ', shell=True)
        else:
            subprocess.Popen([get_config().audio.external_tool, fileabspath])
    except Exception as e:
        logger.error(f"Failed to open audio in external program: {e}")
        return False

def is_connected():
    try:
        # Attempt to connect to a well-known host
        socket.create_connection(("www.google.com", 80), timeout=2)
        return True
    except OSError:
        return False


TEXT_REPLACEMENTS_FILE = os.path.join(get_app_directory(), 'config', 'text_replacements.json')
OCR_REPLACEMENTS_FILE = os.path.join(get_app_directory(), 'config', 'ocr_replacements.json')
os.makedirs(os.path.dirname(TEXT_REPLACEMENTS_FILE), exist_ok=True)


def add_srt_line(line_time, new_line):
    global srt_index
    if get_config().features.generate_longplay and gsm_state.recording_started_time and new_line.prev:
        # logger.info(f"Adding SRT line {new_line.prev.text}... for longplay")
        with open(gsm_state.current_srt, 'a', encoding='utf-8') as srt_file:
            # Calculate start and end times for the previous line
            prev_start_time = new_line.prev.time - gsm_state.recording_started_time
            prev_end_time = (line_time if line_time else datetime.now()) - gsm_state.recording_started_time
            # Format times as SRT timestamps (HH:MM:SS,mmm)
            def format_srt_time(td, offset=0):
                total_seconds = int(td.total_seconds()) + offset
                hours = total_seconds // 3600
                minutes = (total_seconds % 3600) // 60
                seconds = total_seconds % 60
                milliseconds = int(td.microseconds / 1000)
                return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"
            
            srt_file.write(f"{gsm_state.srt_index}\n")
            srt_file.write(f"{format_srt_time(prev_start_time)} --> {format_srt_time(prev_end_time, offset=-1)}\n")
            srt_file.write(f"{new_line.prev.text}\n\n")
            gsm_state.srt_index += 1
            
def preserve_html_tags(original_text, new_text):
    """
    Re-apply tags from original_text onto new_text.
    Works best when new_text == original_text with tags removed.
    Preserves nested tags and elements.
    """
    new_text = new_text.strip()
    if ("<" not in original_text or ">" not in original_text) and "{" not in original_text:
        return new_text

    line_starts = [0]
    for line in original_text.splitlines(keepends=True):
        line_starts.append(line_starts[-1] + len(line))

    def _abs_pos(pos):
        line_no, col = pos
        return line_starts[line_no - 1] + col

    class _TagSpanParser(HTMLParser):
        _VOID_TAGS = {
            "area",
            "base",
            "br",
            "col",
            "embed",
            "hr",
            "img",
            "input",
            "link",
            "meta",
            "param",
            "source",
            "track",
            "wbr",
        }

        def __init__(self):
            super().__init__()
            self.plain = []
            self.index = 0
            self.stack = []
            self.spans = []
            self.boundary_tags = []
            self.in_cloze = False
            self.cloze_type = None
            self.in_hint = False

        def handle_starttag(self, tag, attrs):
            start_tag = self.get_starttag_text() or f"<{tag}>"
            start_pos = _abs_pos(self.getpos())
            if tag.lower() in self._VOID_TAGS:
                self.boundary_tags.append(
                    {
                        "pos": self.index,
                        "start_tag": start_tag,
                        "start_pos": start_pos,
                    }
                )
                return

            depth = len(self.stack)
            self.stack.append(
                {
                    "tag": tag,
                    "start": self.index,
                    "start_tag": start_tag,
                    "depth": depth,
                    "start_pos": start_pos,
                }
            )

        def handle_endtag(self, tag):
            # Pop the nearest matching tag to stay resilient to malformed input.
            end_pos = _abs_pos(self.getpos())
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i]["tag"] == tag:
                    entry = self.stack.pop(i)
                    entry["end"] = self.index
                    entry["end_pos"] = end_pos
                    self.spans.append(entry)
                    return

        def handle_startendtag(self, tag, attrs):
            start_tag = self.get_starttag_text() or f"<{tag}/>"
            self.boundary_tags.append(
                {
                    "pos": self.index,
                    "start_tag": start_tag,
                    "start_pos": _abs_pos(self.getpos()),
                }
            )

        def handle_data(self, data):
            if not data:
                return
            clean = self._consume_text(data)
            if clean:
                self.plain.append(clean)
                self.index += len(clean)

        def _consume_text(self, data):
            out = []
            i = 0
            while i < len(data):
                if not self.in_cloze:
                    if data.startswith("{{c", i):
                        j = i + 3
                        while j < len(data) and data[j].isdigit():
                            j += 1
                        if j > i + 3 and data.startswith("::", j):
                            self.in_cloze = True
                            self.cloze_type = "anki"
                            self.in_hint = False
                            i = j + 2
                            continue
                    if data[i] == "{":
                        self.in_cloze = True
                        self.cloze_type = "single"
                        self.in_hint = False
                        i += 1
                        continue
                    out.append(data[i])
                    i += 1
                    continue

                if self.cloze_type == "anki":
                    if data.startswith("}}", i):
                        self.in_cloze = False
                        self.cloze_type = None
                        self.in_hint = False
                        i += 2
                        continue
                    if not self.in_hint and data.startswith("::", i):
                        self.in_hint = True
                        i += 2
                        continue
                    if not self.in_hint:
                        out.append(data[i])
                    i += 1
                    continue

                if self.cloze_type == "single":
                    if data[i] == "}":
                        self.in_cloze = False
                        self.cloze_type = None
                        self.in_hint = False
                        i += 1
                        continue
                    out.append(data[i])
                    i += 1
                    continue
            return "".join(out)

    parser = _TagSpanParser()
    parser.feed(original_text)

    plain_original = "".join(parser.plain)
    if not parser.spans and not parser.boundary_tags and "{" not in original_text:
        return new_text

    def _normalize(text):
        return re.sub(r"\s+", " ", text).strip()

    def _collect_cloze_spans(text):
        spans = []
        index = 0
        in_tag = False
        in_cloze = False
        cloze_start = 0
        cloze_type = None
        in_hint = False
        hint_buffer = ""
        hint_started = False
        cloze_start_pos = 0
        cloze_start_tag = ""

        i = 0
        while i < len(text):
            ch = text[i]
            if not in_hint and ch == "<":
                in_tag = True
            if not in_tag:
                if not in_cloze and text.startswith("{{c", i):
                    j = i + 3
                    while j < len(text) and text[j].isdigit():
                        j += 1
                    if j > i + 3 and text.startswith("::", j):
                        in_cloze = True
                        cloze_type = "anki"
                        in_hint = False
                        hint_started = False
                        hint_buffer = ""
                        cloze_start = index
                        cloze_start_pos = i
                        cloze_start_tag = text[i : j + 2]
                        i = j + 2
                        continue
                if not in_cloze and ch == "{":
                    if not in_cloze:
                        in_cloze = True
                        cloze_type = "single"
                        in_hint = False
                        cloze_start = index
                        cloze_start_pos = i
                        cloze_start_tag = "{"
                    i += 1
                    continue
                if in_cloze and cloze_type == "anki":
                    if text.startswith("}}", i):
                        end_tag = "}}"
                        if hint_started:
                            end_tag = f"::{hint_buffer}" + "}}"
                        spans.append(
                            {
                                "tag": None,
                                "start": cloze_start,
                                "end": index,
                                "start_tag": cloze_start_tag,
                                "depth": -1,
                                "start_pos": cloze_start_pos,
                                "end_pos": i,
                                "end_tag": end_tag,
                            }
                        )
                        in_cloze = False
                        cloze_type = None
                        in_hint = False
                        hint_started = False
                        hint_buffer = ""
                        i += 2
                        continue
                    if not in_hint and text.startswith("::", i):
                        in_hint = True
                        hint_started = True
                        hint_buffer = ""
                        i += 2
                        continue
                    if in_hint:
                        hint_buffer += ch
                    else:
                        index += 1
                    i += 1
                    continue
                if in_cloze and cloze_type == "single" and ch == "}":
                    if in_cloze:
                        spans.append(
                            {
                                "tag": None,
                                "start": cloze_start,
                                "end": index,
                                "start_tag": cloze_start_tag,
                                "depth": -1,
                                "start_pos": cloze_start_pos,
                                "end_pos": i,
                                "end_tag": "}",
                            }
                        )
                        in_cloze = False
                        cloze_type = None
                        in_hint = False
                    i += 1
                    continue
                if in_cloze:
                    if cloze_type == "single":
                        index += 1
                    # anki handled above
                else:
                    index += 1
            if not in_hint and ch == ">" and in_tag:
                in_tag = False
            i += 1
        return spans

    def _build_boundary_map(source_text, target_text):
        from difflib import SequenceMatcher

        source_len = len(source_text)
        target_len = len(target_text)
        boundary_map = [None] * (source_len + 1)
        boundary_map[0] = 0
        boundary_map[source_len] = target_len

        matcher = SequenceMatcher(None, source_text, target_text, autojunk=False)
        matching_blocks = matcher.get_matching_blocks()
        for src_start, dst_start, size in matching_blocks:
            for offset in range(size + 1):
                src_index = src_start + offset
                if 0 <= src_index <= source_len:
                    boundary_map[src_index] = dst_start + offset

        i = 0
        while i <= source_len:
            if boundary_map[i] is not None:
                i += 1
                continue

            left = i - 1
            while left >= 0 and boundary_map[left] is None:
                left -= 1
            right = i + 1
            while right <= source_len and boundary_map[right] is None:
                right += 1

            left_src = left if left >= 0 else 0
            right_src = right if right <= source_len else source_len
            left_dst = boundary_map[left] if left >= 0 else 0
            right_dst = boundary_map[right] if right <= source_len else target_len
            span = max(1, right_src - left_src)

            for idx in range(i, right):
                ratio = (idx - left_src) / span
                guess = int(round(left_dst + ratio * (right_dst - left_dst)))
                boundary_map[idx] = max(0, min(target_len, guess))

            i = right

        for idx in range(1, source_len + 1):
            if boundary_map[idx] < boundary_map[idx - 1]:
                boundary_map[idx] = boundary_map[idx - 1]

        for idx in range(source_len - 1, -1, -1):
            if boundary_map[idx] > boundary_map[idx + 1]:
                boundary_map[idx] = boundary_map[idx + 1]

        return boundary_map

    def _find_best_occurrence(text, needle, anchor):
        if not needle:
            return None

        pos = text.find(needle)
        if pos == -1:
            return None

        best_pos = pos
        best_distance = abs(pos - anchor)
        while True:
            pos = text.find(needle, pos + 1)
            if pos == -1:
                break
            distance = abs(pos - anchor)
            if distance < best_distance or (distance == best_distance and pos < best_pos):
                best_pos = pos
                best_distance = distance

        return best_pos

    def _extend_over_bracketed_readings(text, end_index):
        """
        Keep furigana-style bracket groups (e.g. [reading]) inside the HTML span when
        they are attached directly to the end of the mapped token.
        """
        cursor = end_index
        while cursor < len(text) and text[cursor] == "[":
            close_index = text.find("]", cursor + 1)
            if close_index == -1:
                break
            cursor = close_index + 1
        return cursor

    cloze_spans = _collect_cloze_spans(original_text)
    all_spans = parser.spans + cloze_spans
    if not all_spans and not parser.boundary_tags:
        return new_text

    if _normalize(plain_original) != _normalize(new_text):
        logger.warning(
            "HTML preservation: stripped original text does not match new text, applying best-effort remap"
        )

    from difflib import SequenceMatcher

    boundary_map = _build_boundary_map(plain_original, new_text)
    resolved_spans = []
    for span in all_spans:
        mapped_start = boundary_map[span["start"]]
        mapped_end = boundary_map[span["end"]]
        if mapped_end < mapped_start:
            mapped_start, mapped_end = mapped_end, mapped_start

        original_span_len = span["end"] - span["start"]
        span_text = plain_original[span["start"] : span["end"]]
        mapped_segment = new_text[mapped_start:mapped_end] if mapped_end > mapped_start else ""
        confidence = (
            SequenceMatcher(None, span_text, mapped_segment, autojunk=False).ratio()
            if mapped_segment
            else 0.0
        )

        if original_span_len > 0 and confidence < 0.6:
            occurrence = _find_best_occurrence(new_text, span_text, mapped_start)
            if occurrence is None:
                continue
            mapped_start = occurrence
            mapped_end = occurrence + len(span_text)

        if original_span_len > 0 and mapped_end <= mapped_start:
            occurrence = _find_best_occurrence(new_text, span_text, mapped_start)
            if occurrence is not None:
                mapped_start = occurrence
                mapped_end = occurrence + len(span_text)

        if span["tag"] is not None and original_span_len > 0:
            mapped_end = _extend_over_bracketed_readings(new_text, mapped_end)

        if original_span_len > 0 and mapped_end <= mapped_start:
            continue

        remapped = dict(span)
        remapped["start"] = max(0, min(len(new_text), mapped_start))
        remapped["end"] = max(0, min(len(new_text), mapped_end))
        resolved_spans.append(remapped)

    resolved_boundary_tags = []
    for tag in parser.boundary_tags:
        mapped_pos = boundary_map[tag["pos"]]
        remapped = dict(tag)
        remapped["pos"] = max(0, min(len(new_text), mapped_pos))
        resolved_boundary_tags.append(remapped)

    opens = {}
    ends = {}
    for span in resolved_spans:
        opens.setdefault(span["start"], []).append(
            {
                "kind": "start",
                "start_pos": span["start_pos"],
                "text": span["start_tag"],
            }
        )
        ends.setdefault(span["end"], []).append(span)
    for tag in resolved_boundary_tags:
        opens.setdefault(tag["pos"], []).append(
            {
                "kind": "boundary",
                "start_pos": tag["start_pos"],
                "text": tag["start_tag"],
            }
        )

    for pos in opens:
        opens[pos].sort(key=lambda item: item["start_pos"])
    for pos in ends:
        ends[pos].sort(key=lambda s: -s["start_pos"])

    out = []
    for pos in range(len(new_text) + 1):
        if pos in ends:
            for s in ends[pos]:
                if s["tag"] is None:
                    out.append(s.get("end_tag", "}"))
                else:
                    out.append(f"</{s['tag']}>")
        if pos in opens:
            for item in opens[pos]:
                out.append(item["text"])
        if pos < len(new_text):
            out.append(new_text[pos])

    return "".join(out)


class SleepManager:
    def __init__(self, initial_delay=1.0, backoff_factor=1.5, name="Generic"):
        self.initial_delay = initial_delay
        self.current_delay = initial_delay
        self.backoff_factor = backoff_factor
        self.name = name

    def _get_max_delay(self):
        # Always fetch latest config
        return get_config().advanced.longest_sleep_time

    def reset(self):
        self.current_delay = self.initial_delay

    def sleep(self):
        max_delay = self._get_max_delay()
        # logger.debug(f"SleepManager '{self.name}' sleeping for {self.current_delay:.2f}s (Max: {max_delay:.2f}s)")
        time.sleep(self.current_delay)
        self.current_delay = min(self.current_delay * self.backoff_factor, max_delay)

    async def async_sleep(self):
        max_delay = self._get_max_delay()
        # logger.debug(f"SleepManager '{self.name}' async sleeping for {self.current_delay:.2f}s (Max: {max_delay:.2f}s)")
        await asyncio.sleep(self.current_delay)
        self.current_delay = min(self.current_delay * self.backoff_factor, max_delay)

# if not os.path.exists(OCR_REPLACEMENTS_FILE):
#     url = "https://raw.githubusercontent.com/bpwhelan/GameSentenceMiner/refs/heads/main/electron-src/assets/ocr_replacements.json"
#     try:
#         with urllib.request.urlopen(url) as response:
#             data = response.read().decode('utf-8')
#             with open(OCR_REPLACEMENTS_FILE, 'w', encoding='utf-8') as f:
#                 f.write(data)
#     except Exception as e:
#         logger.error(f"Failed to fetch JSON from {url}: {e}")
