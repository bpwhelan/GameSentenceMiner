import json
import os
import re
import shutil
import struct
import tempfile
import threading
import wave
import warnings
from abc import abstractmethod, ABC
from dataclasses import dataclass, field, asdict
from functools import partial
from importlib import resources
from typing import Optional

from GameSentenceMiner import mecab
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_temporary_directory,
    is_cuda_available,
    logger,
    FIRERED,
    SILERO,
    WHISPER,
)
from GameSentenceMiner.util.gsm_utils import run_new_thread
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.ffmpeg import get_audio_length
from GameSentenceMiner.util.models.model import VADResult

SIMILARITY_THRESHOLD_DEFAULT = 20.0
SHORT_TEXT_RATIO_DEFAULT = 0.25
SHORT_AUDIO_MIN_SECONDS_DEFAULT = 0.5
SHORT_AUDIO_SECONDS_PER_CHAR_DEFAULT = 0.05

WHISPER_SINGLE_TOKEN_MAX_LENGTH_DEFAULT = 2
WHISPER_ISOLATED_GAP_SECONDS_DEFAULT = 1.0
WHISPER_NO_SPEECH_PROB_SKIP_DEFAULT = 0.9
WHISPER_PAUSE_NO_SPEECH_PROB_SKIP_DEFAULT = 0.3
WHISPER_REPEAT_SEQUENCE_MIN_CHARS_DEFAULT = 3
WHISPER_REPEAT_SEQUENCE_MIN_REPEATS_DEFAULT = 5
WHISPER_UNIQUE_WORDS_MIN_COUNT_DEFAULT = 2

WHISPER_FILLER_SEGMENTS = {"縺医・", "繧・"}

FIRERED_FRAME_LENGTH_S = 0.025
FIRERED_FRAME_SHIFT_S = 0.010
FIRERED_SMOOTH_WINDOW_SIZE_DEFAULT = 5
FIRERED_SPEECH_THRESHOLD_DEFAULT = 0.4
FIRERED_MIN_SPEECH_FRAME_DEFAULT = 20
FIRERED_MAX_SPEECH_FRAME_DEFAULT = 2000
FIRERED_MIN_SILENCE_FRAME_DEFAULT = 20
FIRERED_MERGE_SILENCE_FRAME_DEFAULT = 0
FIRERED_EXTEND_SPEECH_FRAME_DEFAULT = 0


def _get_vad_config_value(name: str, default):
    return getattr(get_config().vad, name, default)


def _get_firered_asset_path(filename: str) -> str:
    return str(resources.files("GameSentenceMiner").joinpath("assets", "fireredvad", filename))


def _load_pcm16_mono_audio_from_wav(path: str):
    import numpy as np

    with wave.open(path, "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        channel_count = wav_file.getnchannels()
        frame_count = wav_file.getnframes()
        raw_audio = wav_file.readframes(frame_count)

    if sample_rate != 16000:
        raise RuntimeError(f"FireRedVAD expected 16 kHz audio, got {sample_rate} Hz from '{path}'")
    if sample_width != 2:
        raise RuntimeError(f"FireRedVAD expected 16-bit PCM audio, got {sample_width * 8}-bit audio from '{path}'")
    if frame_count <= 0:
        raise RuntimeError(f"FireRedVAD temporary wav contains no samples: '{path}'")

    audio = np.frombuffer(raw_audio, dtype="<i2")
    if channel_count > 1:
        audio = audio.reshape(-1, channel_count).mean(axis=1).astype(np.int16)
    return audio


def _read_kaldi_binary_int(handle) -> int:
    size_raw = handle.read(1)
    if len(size_raw) != 1:
        raise RuntimeError("Invalid FireRedVAD CMVN file: missing integer size marker.")
    size = size_raw[0]
    if size != 4:
        raise RuntimeError(f"Invalid FireRedVAD CMVN file: unsupported integer size {size}.")
    value_raw = handle.read(4)
    if len(value_raw) != 4:
        raise RuntimeError("Invalid FireRedVAD CMVN file: truncated integer value.")
    return struct.unpack("<i", value_raw)[0]


def _load_firered_cmvn(path: str):
    import numpy as np

    with open(path, "rb") as handle:
        marker = handle.read(2)
        if marker != b"\0B":
            raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': expected Kaldi binary marker.")

        token = b""
        while True:
            char = handle.read(1)
            if not char:
                raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': missing matrix token.")
            token += char
            if char == b" ":
                break

        if token == b"DM ":
            dtype = "<f8"
            item_size = 8
        elif token == b"FM ":
            dtype = "<f4"
            item_size = 4
        else:
            raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': unsupported matrix token {token!r}.")

        rows = _read_kaldi_binary_int(handle)
        cols = _read_kaldi_binary_int(handle)
        raw_matrix = handle.read(rows * cols * item_size)
        if len(raw_matrix) != rows * cols * item_size:
            raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': truncated matrix data.")

    stats = np.frombuffer(raw_matrix, dtype=dtype).reshape(rows, cols)
    if stats.shape[0] != 2 or stats.shape[1] < 2:
        raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': expected a 2-row CMVN stats matrix.")

    dim = stats.shape[1] - 1
    count = stats[0, dim]
    if count < 1:
        raise RuntimeError(f"Invalid FireRedVAD CMVN file '{path}': invalid frame count {count}.")

    means = stats[0, :dim] / count
    variances = (stats[1, :dim] / count) - means * means
    inverse_std_variances = 1.0 / np.sqrt(np.maximum(variances, 1e-20))
    return means.astype(np.float32), inverse_std_variances.astype(np.float32)


def _load_whisper_audio_from_wav(path: str):
    import numpy as np

    with wave.open(path, "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        channel_count = wav_file.getnchannels()
        frame_count = wav_file.getnframes()
        raw_audio = wav_file.readframes(frame_count)

    if sample_rate != 16000:
        raise RuntimeError(f"Whisper VAD expected 16 kHz audio, got {sample_rate} Hz from '{path}'")
    if sample_width != 2:
        raise RuntimeError(f"Whisper VAD expected 16-bit PCM audio, got {sample_width * 8}-bit audio from '{path}'")
    if frame_count <= 0:
        raise RuntimeError(f"Whisper VAD temporary wav contains no samples: '{path}'")

    audio = np.frombuffer(raw_audio, dtype="<i2")
    if channel_count > 1:
        audio = audio.reshape(-1, channel_count).mean(axis=1)
    return audio.astype(np.float32) / 32768.0


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: Optional[str] = None
    confidence: Optional[float] = None


@dataclass
class DetectionResult:
    segments: list[Segment] = field(default_factory=list)
    text_similarity: float = 100.0
    transcript: str = ""


# Convert the audio to 16kHz mono WAV, evidence https://discord.com/channels/1286409772383342664/1286518821913362445/1407017127529152533
class TempWav:
    def __init__(self, input_audio: str):
        self.input_audio = input_audio
        self.path = None

    def __enter__(self):
        temp_dir = get_temporary_directory()
        os.makedirs(temp_dir, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=temp_dir, suffix=".wav")
        os.close(fd)
        self.path = path
        if not os.path.exists(self.input_audio):
            raise RuntimeError(f"Input audio does not exist: '{self.input_audio}'")
        input_size = os.path.getsize(self.input_audio)
        if input_size <= 0:
            raise RuntimeError(f"Input audio is empty: '{self.input_audio}'")

        result = ffmpeg.convert_audio_to_wav(self.input_audio, self.path, use_filters=True)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed to convert audio to wav: {result.stderr}")
        if not os.path.exists(self.path) or os.path.getsize(self.path) <= 44:
            logger.warning(
                f"FFmpeg produced invalid wav output: '{self.path}' (input size: {input_size}). Retrying without filters."
            )
            result = ffmpeg.convert_audio_to_wav(self.input_audio, self.path, use_filters=False)
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg failed to convert audio to wav (no filters): {result.stderr}")
            if not os.path.exists(self.path) or os.path.getsize(self.path) <= 44:
                raise RuntimeError(f"FFmpeg produced invalid wav output: '{self.path}'")
        return self.path

    def __exit__(self, exc_type, exc, tb):
        if self.path and os.path.exists(self.path):
            try:
                os.remove(self.path)
            except Exception as e:
                logger.warning(f"Failed to remove temporary wav '{self.path}': {e}")
        return False


class VADSystem:
    def __init__(self):
        self.initialized = False
        self.firered = None
        self.silero = None
        self.whisper = None
        self._init_lock = threading.RLock()
        # self.vosk = None
        # self.groq = None

    def ensure_initialized(self):
        if self.initialized:
            return
        with self._init_lock:
            if self.initialized:
                return
            try:
                if get_config().vad.is_firered():
                    self._get_processor(configuration.FIRERED)
                if get_config().vad.is_whisper():
                    self._get_processor(configuration.WHISPER)
                if get_config().vad.is_silero():
                    self._get_processor(configuration.SILERO)
                self.initialized = True
            except Exception as e:
                self.initialized = False
                logger.exception("Error initializing VAD processors, will not use them." + str(e))

    def _preload_models(self):
        try:
            if get_config().vad.is_firered() and self.firered:
                self.firered._ensure_model()
            if get_config().vad.is_whisper() and self.whisper:
                self.whisper._ensure_model()
            if get_config().vad.is_silero() and self.silero:
                self.silero._ensure_model()
        except Exception as e:
            logger.exception("Error pre-loading VAD models: " + str(e))

    def init(self):
        self.ensure_initialized()
        if get_config().vad.preload_vad_model:
            run_new_thread(self._preload_models)
        # if get_config().vad.is_vosk():
        #     if not self.vosk:
        #         self.vosk = VoskVADProcessor()
        # if get_config().vad.is_groq():
        #     if not self.groq:
        #         self.groq = GroqVADProcessor()

    def trim_audio_with_vad(self, input_audio, output_audio, game_line, full_text):
        if get_config().vad.do_vad_postprocessing:
            self.ensure_initialized()
            result = self._do_vad_processing(
                get_config().vad.selected_vad_model,
                input_audio,
                output_audio,
                game_line,
                full_text,
            )
            if not result.success and get_config().vad.backup_vad_model != configuration.OFF:
                logger.info("No voice activity detected, using backup VAD model.")
                result = self._do_vad_processing(
                    get_config().vad.backup_vad_model,
                    input_audio,
                    output_audio,
                    game_line,
                    full_text,
                )
            return result

    def _do_vad_processing(self, model, input_audio, output_audio, game_line, text_mined):
        try:
            match model:
                case configuration.OFF:
                    return VADResult(False, 0, 0, "OFF")
                case configuration.FIRERED:
                    processor = self._get_processor(configuration.FIRERED)
                    return processor.process_audio(input_audio, output_audio, game_line, text_mined)
                case configuration.SILERO:
                    processor = self._get_processor(configuration.SILERO)
                    return processor.process_audio(input_audio, output_audio, game_line, text_mined)
                case configuration.WHISPER:
                    processor = self._get_processor(configuration.WHISPER)
                    return processor.process_audio(input_audio, output_audio, game_line, text_mined)
        except Exception as e:
            logger.exception(f"Error during VAD processing with model {model}: {e}")
            return VADResult(False, 0, 0, model)

    def _get_processor(self, model):
        with self._init_lock:
            if model == configuration.FIRERED:
                if not self.firered:
                    self.firered = FireRedVADProcessor()
                return self.firered
            if model == configuration.SILERO:
                if not self.silero:
                    self.silero = SileroVADProcessor()
                return self.silero
            if model == configuration.WHISPER:
                if not self.whisper:
                    self.whisper = WhisperVADProcessor()
                return self.whisper
        raise ValueError(f"Unsupported VAD model: {model}")


# Base class for VAD systems
class VADProcessor(ABC):
    def __init__(self):
        self.vad_model = None
        self.vad_system_name = None

    @abstractmethod
    def _detect_voice_activity(self, input_audio, text_mined) -> DetectionResult:
        pass

    @staticmethod
    def _create_temp_audio_path(extension: str) -> str:
        temp_dir = get_temporary_directory()
        os.makedirs(temp_dir, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=temp_dir, suffix=extension)
        os.close(fd)
        os.unlink(path)  # Remove the empty placeholder; ffmpeg needs the path to not exist (no -y flag in base command)
        return path

    @staticmethod
    def extract_audio_and_combine_segments(
        input_audio, segments: list[Segment], output_audio, padding=0.1, end_padding=0.0
    ):
        files = []
        ffmpeg_threads = []
        logger.info(f"Extracting {len(segments)} segments from {input_audio} with padding {padding} seconds.")

        current_start = None
        for i, segment in enumerate(segments):
            logger.info(segment)
            if i < len(segments) - 1 and (segments[i + 1].start - segment.end) < (padding * 2 + padding / 2):
                logger.info(f"Adjusting segment {segments[i + 1]} due to insufficient padding.")
                current_start = segment.start if current_start is None else current_start
                continue
            temp_file = VADProcessor._create_temp_audio_path(f".{get_config().audio.extension}")
            files.append(temp_file)
            start = max(
                0,
                (current_start if current_start is not None else segment.start) - (padding * 2),
            )
            end = segment.end + (padding / 2)
            if i == len(segments) - 1:
                end += end_padding
            ffmpeg_threads.append(
                run_new_thread(
                    partial(
                        ffmpeg.trim_audio,
                        input_audio,
                        start,
                        end,
                        temp_file,
                        trim_beginning=True,
                    )
                )
            )
            current_start = None

        for thread in ffmpeg_threads:
            thread.join()

        # Verify each segment was actually written; filter out any that are missing or empty
        valid_files = [f for f in files if os.path.exists(f) and os.path.getsize(f) > 0]
        if not valid_files:
            raise RuntimeError(
                f"cut-and-splice produced no valid segment files from {len(files)} expected segments. "
                "Check ffmpeg logs for errors."
            )
        if len(valid_files) < len(files):
            logger.warning(
                f"{len(files) - len(valid_files)} segment(s) failed to produce output; combining {len(valid_files)} valid segment(s)."
            )

        # Clean up any empty/missing temp files that were not produced
        for f in files:
            if f not in valid_files and os.path.exists(f):
                try:
                    os.remove(f)
                except Exception:
                    pass

        if len(valid_files) > 1:
            ffmpeg.combine_audio_files(valid_files, output_audio)
            for file in valid_files:
                try:
                    os.remove(file)
                except Exception:
                    pass
        else:
            shutil.move(valid_files[0], output_audio)

    def process_audio(self, input_audio, output_audio, game_line, text_mined):
        detection = self._detect_voice_activity(input_audio, text_mined)
        decision = self._validate_detection(detection, game_line, input_audio)
        return self._render_decision(decision, detection, input_audio, output_audio)

    def _validate_detection(self, detection: DetectionResult, game_line, input_audio):
        if not detection or not detection.segments:
            logger.info("No voice activity detected in the audio.")
            return "reject"

        start_time = detection.segments[0].start
        end_time = detection.segments[-1].end

        # Attempt to fix the end time if the last segment is too short
        if game_line and game_line.next_line() and len(detection.segments) > 1:
            audio_length = get_audio_length(input_audio)
            if 0 > audio_length - detection.segments[-1].start + get_config().audio.beginning_offset:
                end_time = detection.segments[-2].end

        if game_line and game_line.text and not detection.transcript:
            min_seconds = _get_vad_config_value("short_audio_min_seconds", SHORT_AUDIO_MIN_SECONDS_DEFAULT)
            seconds_per_char = _get_vad_config_value(
                "short_audio_seconds_per_char", SHORT_AUDIO_SECONDS_PER_CHAR_DEFAULT
            )
            expected_min = max(min_seconds, len(game_line.text) * seconds_per_char)
            if (end_time - start_time) < expected_min:
                logger.info(
                    f"Detected audio length {end_time - start_time:.2f} is much shorter than expected for text '{game_line.text}', skipping."
                )
                return "reject"

        return (start_time, end_time)

    def _render_decision(self, decision, detection: DetectionResult, input_audio, output_audio):
        if decision == "reject":
            return VADResult(False, 0, 0, self.vad_system_name)

        start_time, end_time = decision
        if get_config().vad.cut_and_splice_segments:
            self.extract_audio_and_combine_segments(
                input_audio,
                detection.segments,
                output_audio,
                padding=get_config().vad.splice_padding,
                end_padding=get_config().audio.end_offset,
            )
        else:
            ffmpeg.trim_audio(
                input_audio,
                start_time + get_config().vad.beginning_offset,
                end_time + get_config().audio.end_offset,
                output_audio,
                trim_beginning=get_config().vad.trim_beginning,
                fade_in_duration=0.05,
                fade_out_duration=0,
            )
        return VADResult(
            True,
            max(0, start_time + get_config().vad.beginning_offset),
            max(0, end_time + get_config().audio.end_offset),
            self.vad_system_name,
            detection.segments,
            output_audio,
        )


class FireRedFeatureExtractor:
    def __init__(self, cmvn_path: str):
        try:
            import kaldi_native_fbank as knf
        except ImportError as e:
            raise RuntimeError(
                "FireRedVAD requires the 'kaldi-native-fbank' package. "
                "Install/update GSM dependencies before selecting FireRedVAD."
            ) from e

        self._knf = knf
        self._means, self._inverse_std_variances = _load_firered_cmvn(cmvn_path)
        self._opts = knf.FbankOptions()
        self._opts.frame_opts.samp_freq = 16000
        self._opts.frame_opts.frame_length_ms = 25
        self._opts.frame_opts.frame_shift_ms = 10
        self._opts.frame_opts.dither = 0.0
        self._opts.frame_opts.snip_edges = True
        self._opts.mel_opts.num_bins = 80
        self._opts.mel_opts.debug_mel = False

    def extract(self, wav_path: str):
        import numpy as np

        audio = _load_pcm16_mono_audio_from_wav(wav_path)
        duration = audio.shape[0] / 16000
        fbank = self._knf.OnlineFbank(self._opts)
        fbank.accept_waveform(16000, audio.tolist())

        frames = [fbank.get_frame(index) for index in range(fbank.num_frames_ready)]
        if not frames:
            return np.zeros((0, 80), dtype=np.float32), duration

        features = np.vstack(frames).astype(np.float32)
        features = (features - self._means) * self._inverse_std_variances
        return features.astype(np.float32, copy=False), duration


class FireRedVADPostprocessor:
    def __init__(
        self,
        smooth_window_size: int,
        speech_threshold: float,
        min_speech_frame: int,
        max_speech_frame: int,
        min_silence_frame: int,
        merge_silence_frame: int,
        extend_speech_frame: int,
    ):
        self.smooth_window_size = max(1, smooth_window_size)
        self.speech_threshold = speech_threshold
        self.min_speech_frame = min_speech_frame
        self.max_speech_frame = max_speech_frame
        self.min_silence_frame = min_silence_frame
        self.merge_silence_frame = merge_silence_frame
        self.extend_speech_frame = extend_speech_frame

    def process(self, raw_probs) -> list[int]:
        if len(raw_probs) == 0:
            return []

        smoothed_probs = self._smooth_prob(raw_probs)
        binary_preds = self._apply_threshold(smoothed_probs)
        decisions = self._smooth_preds_with_state_machine(binary_preds)
        decisions = self._fix_smooth_window_start(decisions)
        decisions = self._merge_short_silence_segments(decisions)
        decisions = self._extend_speech_segments(decisions)
        return self._split_long_speech_segments(decisions, raw_probs)

    def decision_to_segment(self, decisions: list[int], wav_duration: float | None = None) -> list[tuple[float, float]]:
        segments = []
        speech_start = None
        for frame_index, decision in enumerate(decisions):
            if decision == 1 and speech_start is None:
                speech_start = frame_index
            elif decision == 0 and speech_start is not None:
                if (frame_index - speech_start) < self.min_speech_frame:
                    logger.warning("Unexpected short FireRedVAD speech segment.")
                segments.append((speech_start * FIRERED_FRAME_SHIFT_S, frame_index * FIRERED_FRAME_SHIFT_S))
                speech_start = None

        if speech_start is not None:
            frame_index = len(decisions) - 1
            if (frame_index - speech_start) < self.min_speech_frame:
                logger.warning("Unexpected short FireRedVAD speech segment.")
            end_time = len(decisions) * FIRERED_FRAME_SHIFT_S + FIRERED_FRAME_LENGTH_S
            if wav_duration is not None:
                end_time = min(end_time, wav_duration)
            segments.append((speech_start * FIRERED_FRAME_SHIFT_S, end_time))

        return [(round(start, 3), round(end, 3)) for start, end in segments]

    def _smooth_prob(self, probs):
        import numpy as np

        if self.smooth_window_size <= 1:
            return np.asarray(probs)

        probs_np = np.asarray(probs)
        kernel = np.ones(self.smooth_window_size) / self.smooth_window_size
        smoothed = np.convolve(probs_np, kernel, mode="full")[: len(probs_np)]
        for index in range(min(self.smooth_window_size - 1, len(probs_np))):
            smoothed[index] = np.mean(probs_np[: index + 1])
        return smoothed

    def _apply_threshold(self, probs) -> list[int]:
        import numpy as np

        return (np.asarray(probs) >= self.speech_threshold).astype(int).tolist()

    def _smooth_preds_with_state_machine(self, binary_preds: list[int]) -> list[int]:
        silence, possible_speech, speech, possible_silence = range(4)
        decisions = [0] * len(binary_preds)
        state = silence
        speech_start = -1
        silence_start = -1

        for frame_index, is_speech in enumerate(binary_preds):
            if state == silence:
                if is_speech:
                    state = possible_speech
                    speech_start = frame_index
            elif state == possible_speech:
                if is_speech:
                    if frame_index - speech_start >= self.min_speech_frame:
                        state = speech
                        decisions[speech_start:frame_index] = [1] * (frame_index - speech_start)
                else:
                    state = silence
                    speech_start = -1
            elif state == speech:
                if not is_speech:
                    state = possible_silence
                    silence_start = frame_index
            elif state == possible_silence:
                if not is_speech:
                    if frame_index - silence_start >= self.min_silence_frame:
                        state = silence
                        speech_start = -1
                else:
                    state = speech
                    silence_start = -1

            if state in {speech, possible_silence}:
                decisions[frame_index] = 1

        return decisions

    def _fix_smooth_window_start(self, decisions: list[int]) -> list[int]:
        new_decisions = decisions.copy()
        for frame_index, decision in enumerate(decisions):
            if frame_index > 0 and decisions[frame_index - 1] == 0 and decision == 1:
                start = max(0, frame_index - self.smooth_window_size)
                new_decisions[start:frame_index] = [1] * (frame_index - start)
        return new_decisions

    def _merge_short_silence_segments(self, decisions: list[int]) -> list[int]:
        if self.merge_silence_frame <= 0:
            return decisions

        new_decisions = decisions.copy()
        silence_start = None
        for frame_index, decision in enumerate(decisions):
            if frame_index > 0 and decisions[frame_index - 1] == 1 and decision == 0 and silence_start is None:
                silence_start = frame_index
            elif frame_index > 0 and decisions[frame_index - 1] == 0 and decision == 1 and silence_start is not None:
                silence_frame = frame_index - silence_start
                if silence_frame < self.merge_silence_frame:
                    new_decisions[silence_start:frame_index] = [1] * silence_frame
                silence_start = None
        return new_decisions

    def _extend_speech_segments(self, decisions: list[int]) -> list[int]:
        import numpy as np

        if self.extend_speech_frame <= 0:
            return decisions

        decisions_np = np.asarray(decisions)
        kernel = np.ones(2 * self.extend_speech_frame + 1)
        extended = np.convolve(decisions_np, kernel, mode="same")
        return (extended > 0).astype(int).tolist()

    def _split_long_speech_segments(self, decisions: list[int], probs) -> list[int]:
        import numpy as np

        new_decisions = decisions.copy()
        for start_seconds, end_seconds in self.decision_to_segment(decisions):
            start_frame = int(start_seconds / FIRERED_FRAME_SHIFT_S)
            end_frame = int(end_seconds / FIRERED_FRAME_SHIFT_S)
            duration_frames = end_frame - start_frame
            if duration_frames <= self.max_speech_frame:
                continue

            segment_probs = probs[start_frame:end_frame]
            start = 0
            while start < len(segment_probs) and (len(segment_probs) - start) > self.max_speech_frame:
                window_start = int(start + self.max_speech_frame / 2)
                window_end = int(start + self.max_speech_frame)
                split_frame = start_frame + window_start + int(np.argmin(segment_probs[window_start:window_end]))
                new_decisions[split_frame] = 0
                start = split_frame - start_frame + 1
        return new_decisions


class FireRedVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self._load_lock = threading.Lock()
        self._feature_extractor = None
        self._postprocessor = None
        self.vad_system_name = FIRERED

    def _ensure_model(self):
        if self.vad_model and self._feature_extractor and self._postprocessor:
            return
        with self._load_lock:
            if self.vad_model and self._feature_extractor and self._postprocessor:
                return

            import onnxruntime as ort

            model_path = _get_firered_asset_path("fireredvad_vad.onnx")
            available_providers = ort.get_available_providers()
            use_cpu = get_config().vad.use_cpu_for_inference_v2
            providers = ["CPUExecutionProvider"]
            if not use_cpu and "CUDAExecutionProvider" in available_providers:
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]

            try:
                self.vad_model = ort.InferenceSession(model_path, providers=providers)
            except Exception:
                if providers[0] != "CPUExecutionProvider":
                    logger.warning("FireRedVAD GPU loading failed, falling back to CPU.")
                    self.vad_model = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
                else:
                    raise

            self._feature_extractor = FireRedFeatureExtractor(_get_firered_asset_path("cmvn.ark"))
            self._postprocessor = FireRedVADPostprocessor(
                smooth_window_size=int(
                    _get_vad_config_value("firered_smooth_window_size", FIRERED_SMOOTH_WINDOW_SIZE_DEFAULT)
                ),
                speech_threshold=float(
                    _get_vad_config_value("firered_speech_threshold", FIRERED_SPEECH_THRESHOLD_DEFAULT)
                ),
                min_speech_frame=int(
                    _get_vad_config_value("firered_min_speech_frame", FIRERED_MIN_SPEECH_FRAME_DEFAULT)
                ),
                max_speech_frame=int(
                    _get_vad_config_value("firered_max_speech_frame", FIRERED_MAX_SPEECH_FRAME_DEFAULT)
                ),
                min_silence_frame=int(
                    _get_vad_config_value("firered_min_silence_frame", FIRERED_MIN_SILENCE_FRAME_DEFAULT)
                ),
                merge_silence_frame=int(
                    _get_vad_config_value("firered_merge_silence_frame", FIRERED_MERGE_SILENCE_FRAME_DEFAULT)
                ),
                extend_speech_frame=int(
                    _get_vad_config_value("firered_extend_speech_frame", FIRERED_EXTEND_SPEECH_FRAME_DEFAULT)
                ),
            )
            logger.info(f"FireRedVAD ONNX model loaded with providers: {self.vad_model.get_providers()}")

    def _detect_voice_activity(self, input_audio, text_mined) -> DetectionResult:
        import numpy as np

        self._ensure_model()
        with TempWav(input_audio) as temp_wav:
            features, duration = self._feature_extractor.extract(temp_wav)

        if features.shape[0] <= 0:
            return DetectionResult(segments=[])

        outputs = self.vad_model.run(None, {"feat": features[np.newaxis, :, :].astype(np.float32, copy=False)})
        probabilities = np.asarray(outputs[0], dtype=np.float32).squeeze()
        if probabilities.ndim == 0:
            probabilities = probabilities.reshape(1)

        decisions = self._postprocessor.process(probabilities.tolist())
        timestamps = self._postprocessor.decision_to_segment(decisions, duration)
        segments = [Segment(start=float(start), end=float(end)) for start, end in timestamps if end > start]
        logger.debug(segments)
        return DetectionResult(segments=segments)


class SileroVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self._load_lock = threading.Lock()
        self.vad_system_name = SILERO

    def _ensure_model(self):
        # faster-whisper bundles the Silero VAD as ONNX and lru_caches it internally;
        # warm it up here so preloading (VADSystem._preload_models) actually loads the model.
        if self.vad_model:
            return
        with self._load_lock:
            if self.vad_model:
                return
            from faster_whisper.vad import get_vad_model

            self.vad_model = get_vad_model()

    def _detect_voice_activity(self, input_audio, text_mined) -> DetectionResult:
        from faster_whisper.vad import get_speech_timestamps, VadOptions

        self._ensure_model()
        with TempWav(input_audio) as temp_wav:
            audio = _load_whisper_audio_from_wav(temp_wav)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                # Match the standalone silero-vad package defaults (tuned for trimming a short
                # clip), not faster-whisper's long-audio chunking defaults (400ms pad / 2s silence).
                speech_timestamps = get_speech_timestamps(
                    audio,
                    VadOptions(
                        threshold=0.5,
                        min_speech_duration_ms=250,
                        min_silence_duration_ms=100,
                        speech_pad_ms=30,
                    ),
                    sampling_rate=16000,
                )
        # faster-whisper returns sample indices; convert to seconds.
        segments = [Segment(start=item["start"] / 16000, end=item["end"] / 16000) for item in speech_timestamps]
        logger.debug(segments)
        return DetectionResult(segments=segments)


class WhisperVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self._load_lock = threading.Lock()
        self.vad_system_name = WHISPER

    def load_whisper_model(self):
        from faster_whisper import WhisperModel
        import warnings

        if not self.vad_model:
            model_name = get_config().vad.whisper_model

            # Default to trying GPU with float16 (fastest on most modern GPUs)
            use_cpu = get_config().vad.use_cpu_for_inference_v2
            device = "cuda" if is_cuda_available() and not use_cpu else "cpu"
            # device = "cpu"
            compute_type = "float16" if device == "cuda" else "int8"  # int8 is fastest/lowest memory on CPU

            logger.info(
                f"Attempting to load Whisper model '{model_name}' on {device} with compute_type='{compute_type}'..."
            )

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                try:
                    self.vad_model = WhisperModel(
                        model_name,
                        device=device,
                        compute_type=compute_type,
                    )
                    logger.info(
                        f"Whisper model '{model_name}' loaded successfully on {device} (compute_type='{compute_type}')."
                    )
                except Exception as e:  # Catches CUDA library errors, unsupported device, etc.
                    logger.warning(f"GPU loading failed ({str(e)}), falling back to CPU with int8 quantization...")
                    device = "cpu"
                    compute_type = "int8"  # Fastest/lowest memory on CPU
                    self.vad_model = WhisperModel(
                        model_name,
                        device=device,
                        compute_type=compute_type,
                    )
                    logger.info(f"Whisper model '{model_name}' loaded on {device} (compute_type='{compute_type}').")

        return self.vad_model

    @staticmethod
    def _calculate_similarity(text_mined: str, transcript: str) -> float:
        if not text_mined or not transcript:
            return 0.0
        from rapidfuzz import fuzz

        text_hiragana = mecab.to_hiragana(transcript)
        text_mined_hiragana = mecab.to_hiragana(text_mined)
        return fuzz.ratio(text_mined_hiragana, text_hiragana)

    @staticmethod
    def _passes_similarity_gate(text_mined: str, transcript: str) -> tuple[bool, float]:
        similarity = WhisperVADProcessor._calculate_similarity(text_mined, transcript)
        threshold = _get_vad_config_value("similarity_threshold", SIMILARITY_THRESHOLD_DEFAULT)
        return similarity >= threshold, similarity

    @staticmethod
    def _is_short_transcript(text_mined: str, transcript: str) -> bool:
        if not text_mined or not transcript:
            return False
        ratio = _get_vad_config_value("short_text_ratio", SHORT_TEXT_RATIO_DEFAULT)
        return len(transcript) < len(text_mined) * ratio

    @staticmethod
    def _has_excessive_repetition(text: str) -> bool:
        min_chars = _get_vad_config_value("repeat_sequence_min_chars", WHISPER_REPEAT_SEQUENCE_MIN_CHARS_DEFAULT)
        min_repeats = _get_vad_config_value("repeat_sequence_min_repeats", WHISPER_REPEAT_SEQUENCE_MIN_REPEATS_DEFAULT)
        if min_repeats <= 1:
            return False
        pattern = rf"(.{{{min_chars},}})\1{{{min_repeats - 1},}}"
        return re.search(pattern, text) is not None

    def _ensure_model(self):
        if self.vad_model:
            return
        with self._load_lock:
            if self.vad_model:
                return
            self.vad_model = self.load_whisper_model()

    def _detect_voice_activity(self, input_audio, text_mined) -> DetectionResult:
        self._ensure_model()

        logger.info("Transcribing audio...")

        # Transcribe the audio using Whisper
        with TempWav(input_audio) as temp_wav:
            whisper_audio = _load_whisper_audio_from_wav(temp_wav)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                segments_iter, _info = self.vad_model.transcribe(
                    whisper_audio,
                    language=get_config().general.target_language,
                    vad_filter=get_config().vad.use_vad_filter_for_whisper,
                    temperature=0.0,
                    chunk_length=30,
                    condition_on_previous_text=False,
                    word_timestamps=True,  # populates segment.words (used by the unique-words filter below)
                )
                # faster-whisper yields segments lazily; materialize now to force transcription
                # before the similarity gate, which needs the full transcript.
                result_segments = list(segments_iter)

        segments = []

        logger.debug(json.dumps([asdict(s) for s in result_segments], ensure_ascii=False, default=str))

        transcript = "".join(s.text for s in result_segments).strip()
        text_similarity = 100.0

        # If both mined text and Whisper transcription are available, compare their similarity
        if text_mined and transcript:
            passes, similarity = self._passes_similarity_gate(text_mined, transcript)
            logger.info(
                f"Whisper transcription: '{transcript}' | Mined text: '{text_mined}' | Full similarity: {similarity:.1f}"
            )
            text_similarity = similarity
            if not passes:
                logger.warning(f"Full similarity {similarity:.1f} is below threshold, skipping voice activity.")
                return DetectionResult(segments=[], text_similarity=text_similarity, transcript=transcript)
            if self._is_short_transcript(text_mined, transcript):
                logger.info(f"Detected text '{transcript}' is much shorter than expected '{text_mined}', skipping.")
                return DetectionResult(segments=[], text_similarity=text_similarity, transcript=transcript)

        # Process the segments to extract tokens, timestamps, and confidence
        for i, segment in enumerate(result_segments):
            isolated_gap = _get_vad_config_value("whisper_isolated_gap_seconds", WHISPER_ISOLATED_GAP_SECONDS_DEFAULT)
            short_len = _get_vad_config_value(
                "whisper_single_token_max_length",
                WHISPER_SINGLE_TOKEN_MAX_LENGTH_DEFAULT,
            )
            if len(segment.text) <= short_len and (
                (i > 1 and segment.start - result_segments[i - 1].end > isolated_gap)
                or (i < len(result_segments) - 1 and result_segments[i + 1].start - segment.end > isolated_gap)
            ):
                if segment.text in WHISPER_FILLER_SEGMENTS:
                    logger.debug(f"Skipping filler segment: {segment.text} at {segment.start}-{segment.end}")
                    continue
                logger.info(
                    "Unknown single character segment, not skipping, but logging, please report if this is a mistake: "
                    + segment.text
                )

            # Skip segments with excessive repeating sequences of at least 3 characters
            if self._has_excessive_repetition(segment.text):
                logger.debug(
                    f"Skipping segment with excessive repeating sequence (>=5): '{segment.text}' at {segment.start}-{segment.end}. Likely Hallucination."
                )
                continue

            no_speech_prob_skip = _get_vad_config_value(
                "whisper_no_speech_prob_skip", WHISPER_NO_SPEECH_PROB_SKIP_DEFAULT
            )
            if segment.no_speech_prob and segment.no_speech_prob > no_speech_prob_skip:
                logger.debug(
                    f"Skipping segment with high no_speech_prob: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}"
                )
                continue

            if getattr(segment, "words", None):
                unique_words = set(word.word for word in segment.words)
                min_unique = _get_vad_config_value(
                    "whisper_unique_words_min_count",
                    WHISPER_UNIQUE_WORDS_MIN_COUNT_DEFAULT,
                )
                if len(unique_words) < min_unique and len(segment.words) > 1:
                    logger.debug(
                        f"Skipping segment with low unique words: {unique_words} for segment {segment.text} at {segment.start}-{segment.end}"
                    )
                    continue

            pause_no_speech_prob_skip = _get_vad_config_value(
                "whisper_pause_no_speech_prob_skip",
                WHISPER_PAUSE_NO_SPEECH_PROB_SKIP_DEFAULT,
            )
            if segment.seek > 0 and segment.no_speech_prob > pause_no_speech_prob_skip:
                logger.debug(
                    f"Skipping segment after long pause with high no_speech_prob after: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}"
                )
                continue

            logger.debug(asdict(segment))
            segments.append(
                Segment(
                    text=segment.text,
                    start=segment.start,
                    end=segment.end,
                    confidence=segment.avg_logprob,
                )
            )

        return DetectionResult(segments=segments, text_similarity=text_similarity, transcript=transcript)


vad_processor = VADSystem()


if __name__ == "__main__":
    whisper_processor = WhisperVADProcessor()
    has_excessive = whisper_processor._has_excessive_repetition(
        "うううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううううう"
    )
    print("Has excessive repetition:", has_excessive)
