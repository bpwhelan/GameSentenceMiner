import json
import os
import re
import shutil
import tempfile
import threading
import warnings
from abc import abstractmethod, ABC
from dataclasses import dataclass, field
from functools import partial
from typing import Optional

from GameSentenceMiner import mecab
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import get_config, get_temporary_directory, logger, SILERO, WHISPER
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


def _get_vad_config_value(name: str, default):
    return getattr(get_config().vad, name, default)


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
                if get_config().vad.is_whisper():
                    self._get_processor(configuration.WHISPER)
                if get_config().vad.is_silero():
                    self._get_processor(configuration.SILERO)
                self.initialized = True
            except Exception as e:
                self.initialized = False
                logger.exception("Error initializing VAD processors, will not use them." + str(e))

    def init(self):
        self.ensure_initialized()
        # if get_config().vad.is_vosk():
        #     if not self.vosk:
        #         self.vosk = VoskVADProcessor()
        # if get_config().vad.is_groq():
        #     if not self.groq:
        #         self.groq = GroqVADProcessor()

    def trim_audio_with_vad(self, input_audio, output_audio, game_line, full_text):
        if get_config().vad.do_vad_postprocessing:
            self.ensure_initialized()
            result = self._do_vad_processing(get_config().vad.selected_vad_model, input_audio, output_audio, game_line, full_text)
            if not result.success and get_config().vad.backup_vad_model != configuration.OFF:
                logger.info("No voice activity detected, using backup VAD model.")
                result = self._do_vad_processing(get_config().vad.backup_vad_model, input_audio, output_audio, game_line, full_text)
            return result

    def _do_vad_processing(self, model, input_audio, output_audio, game_line, text_mined):
        try:
            match model:
                case configuration.OFF:
                    return VADResult(False, 0, 0, "OFF")
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
        return path

    @staticmethod
    def extract_audio_and_combine_segments(input_audio, segments: list[Segment], output_audio, padding=0.1):
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
            start = (current_start if current_start is not None else segment.start) - (padding * 2)
            end = segment.end + (padding / 2)
            ffmpeg_threads.append(run_new_thread(
                partial(ffmpeg.trim_audio, input_audio, start, end, temp_file, trim_beginning=True)))
            current_start = None

        for thread in ffmpeg_threads:
            thread.join()

        if len(files) > 1:
            ffmpeg.combine_audio_files(files, output_audio)
            for file in files:
                os.remove(file)
        else:
            shutil.move(files[0], output_audio)


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
            seconds_per_char = _get_vad_config_value("short_audio_seconds_per_char", SHORT_AUDIO_SECONDS_PER_CHAR_DEFAULT)
            expected_min = max(min_seconds, len(game_line.text) * seconds_per_char)
            if (end_time - start_time) < expected_min:
                logger.info(f"Detected audio length {end_time - start_time:.2f} is much shorter than expected for text '{game_line.text}', skipping.")
                return "reject"

        return (start_time, end_time)

    def _render_decision(self, decision, detection: DetectionResult, input_audio, output_audio):
        if decision == "reject":
            return VADResult(False, 0, 0, self.vad_system_name)

        start_time, end_time = decision
        if get_config().vad.cut_and_splice_segments:
            self.extract_audio_and_combine_segments(input_audio, detection.segments, output_audio, padding=get_config().vad.splice_padding)
        else:
            ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio, trim_beginning=get_config().vad.trim_beginning, fade_in_duration=0.05, fade_out_duration=0)
        return VADResult(True, max(0, start_time + get_config().vad.beginning_offset), max(0, end_time + get_config().audio.end_offset), self.vad_system_name, detection.segments, output_audio)

class SileroVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self._load_lock = threading.Lock()
        self.vad_system_name = SILERO

    def _ensure_model(self):
        if self.vad_model:
            return
        with self._load_lock:
            if self.vad_model:
                return
            from silero_vad import load_silero_vad
            self.vad_model = load_silero_vad()

    def _detect_voice_activity(self, input_audio, text_mined) -> DetectionResult:
        from silero_vad import read_audio, get_speech_timestamps
        self._ensure_model()
        with TempWav(input_audio) as temp_wav:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                wav = read_audio(temp_wav)
            speech_timestamps = get_speech_timestamps(wav, self.vad_model, return_seconds=True)
        logger.debug(speech_timestamps)
        segments = [Segment(start=item["start"], end=item["end"]) for item in speech_timestamps]
        return DetectionResult(segments=segments)

class WhisperVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self._load_lock = threading.Lock()
        self.vad_system_name = WHISPER

    def load_whisper_model(self):
        import stable_whisper as whisper
        import warnings

        if not self.vad_model:
            model_name = get_config().vad.whisper_model

            # Default to trying GPU with float16 (fastest on most modern GPUs)
            # use_cpu = get_config().vad.force_whisper_cpu
            # device = "cuda" if is_cuda_available() and not use_cpu else "cpu"
            device = "cpu"
            compute_type = "float16" if device == "cuda" else "int8"  # int8 is fastest/lowest memory on CPU

            logger.info(f"Attempting to load Whisper model '{model_name}' on {device} with compute_type='{compute_type}'...")

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                try:
                    self.vad_model = whisper.load_faster_whisper(
                        model_name,
                        device=device,
                        compute_type=compute_type,
                    )
                    logger.info(f"Whisper model '{model_name}' loaded successfully on {device} (compute_type='{compute_type}').")
                except Exception as e:  # Catches CUDA library errors, unsupported device, etc.
                    logger.warning(f"GPU loading failed ({str(e)}), falling back to CPU with int8 quantization...")
                    device = "cpu"
                    compute_type = "int8"  # Fastest/lowest memory on CPU
                    self.vad_model = whisper.load_faster_whisper(
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
        from stable_whisper import WhisperResult
        self._ensure_model()

        logger.info('Transcribing audio...')

        # Transcribe the audio using Whisper
        with TempWav(input_audio) as temp_wav:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                transcribe_kwargs = {
                    "vad": True,
                    "language": get_config().general.target_language,
                    "vad_filter": get_config().vad.use_vad_filter_for_whisper,
                    "temperature": 0.0,
                    "chunk_length": 15,
                }
                try:
                    import inspect
                    transcribe_params = inspect.signature(self.vad_model.transcribe).parameters
                    if "condition_on_previous_text" in transcribe_params:
                        transcribe_kwargs["condition_on_previous_text"] = False
                except Exception:
                    # If we can't introspect, stick with safe defaults.
                    pass

                result: WhisperResult = self.vad_model.transcribe(temp_wav, **transcribe_kwargs)
        segments = []

        logger.debug(json.dumps(result.to_dict()))

        transcript = result.text.strip()
        text_similarity = 100.0

        # If both mined text and Whisper transcription are available, compare their similarity
        if text_mined and transcript:
            passes, similarity = self._passes_similarity_gate(text_mined, transcript)
            logger.info(f"Whisper transcription: '{transcript}' | Mined text: '{text_mined}' | Full similarity: {similarity:.1f}")
            text_similarity = similarity
            if not passes:
                logger.warning(f"Full similarity {similarity:.1f} is below threshold, skipping voice activity.")
                return DetectionResult(segments=[], text_similarity=text_similarity, transcript=transcript)
            if self._is_short_transcript(text_mined, transcript):
                logger.info(f"Detected text '{transcript}' is much shorter than expected '{text_mined}', skipping.")
                return DetectionResult(segments=[], text_similarity=text_similarity, transcript=transcript)

        # Process the segments to extract tokens, timestamps, and confidence
        for i, segment in enumerate(result.segments):
            isolated_gap = _get_vad_config_value("whisper_isolated_gap_seconds", WHISPER_ISOLATED_GAP_SECONDS_DEFAULT)
            short_len = _get_vad_config_value("whisper_single_token_max_length", WHISPER_SINGLE_TOKEN_MAX_LENGTH_DEFAULT)
            if len(segment.text) <= short_len and (
                (i > 1 and segment.start - result.segments[i - 1].end > isolated_gap)
                or (i < len(result.segments) - 1 and result.segments[i + 1].start - segment.end > isolated_gap)
            ):
                if segment.text in WHISPER_FILLER_SEGMENTS:
                    logger.debug(f"Skipping filler segment: {segment.text} at {segment.start}-{segment.end}")
                    continue
                logger.info(
                    "Unknown single character segment, not skipping, but logging, please report if this is a mistake: " + segment.text)

            # Skip segments with excessive repeating sequences of at least 3 characters
            if self._has_excessive_repetition(segment.text):
                logger.debug(f"Skipping segment with excessive repeating sequence (>=5): '{segment.text}' at {segment.start}-{segment.end}. Likely Hallucination.")
                continue

            no_speech_prob_skip = _get_vad_config_value("whisper_no_speech_prob_skip", WHISPER_NO_SPEECH_PROB_SKIP_DEFAULT)
            if segment.no_speech_prob and segment.no_speech_prob > no_speech_prob_skip:
                logger.debug(f"Skipping segment with high no_speech_prob: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}")
                continue

            if getattr(segment, "words", None):
                unique_words = set(word.word for word in segment.words)
                min_unique = _get_vad_config_value("whisper_unique_words_min_count", WHISPER_UNIQUE_WORDS_MIN_COUNT_DEFAULT)
                if len(unique_words) < min_unique and len(segment.words) > 1:
                    logger.debug(f"Skipping segment with low unique words: {unique_words} for segment {segment.text} at {segment.start}-{segment.end}")
                    continue

            pause_no_speech_prob_skip = _get_vad_config_value("whisper_pause_no_speech_prob_skip", WHISPER_PAUSE_NO_SPEECH_PROB_SKIP_DEFAULT)
            if segment.seek > 0 and segment.no_speech_prob > pause_no_speech_prob_skip:
                logger.debug(f"Skipping segment after long pause with high no_speech_prob after: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}")
                continue

            logger.debug(segment.to_dict())
            segments.append(Segment(
                text=segment.text,
                start=segment.start,
                end=segment.end,
                confidence=segment.avg_logprob,
            ))

        return DetectionResult(segments=segments, text_similarity=text_similarity, transcript=transcript)

vad_processor = VADSystem()
