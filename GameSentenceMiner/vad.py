import tempfile
import time
import warnings
from abc import abstractmethod, ABC

from GameSentenceMiner.util import configuration, ffmpeg
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.ffmpeg import get_audio_length
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, run_new_thread
from GameSentenceMiner.util.model import VADResult


class VADSystem:
    def __init__(self):
        self.silero = None
        self.whisper = None
        self.vosk = None
        self.groq = None

    def init(self):
        if get_config().vad.is_whisper():
            if not self.whisper:
                self.whisper = WhisperVADProcessor()
        if get_config().vad.is_silero():
            if not self.silero:
                self.silero = SileroVADProcessor()
        if get_config().vad.is_vosk():
            if not self.vosk:
                self.vosk = VoskVADProcessor()
        if get_config().vad.is_groq():
            if not self.groq:
                self.groq = GroqVADProcessor()

    def trim_audio_with_vad(self, input_audio, output_audio, game_line):
        if get_config().vad.do_vad_postprocessing:
            result = self._do_vad_processing(get_config().vad.selected_vad_model, input_audio, output_audio, game_line)
            if not result.success and get_config().vad.backup_vad_model != configuration.OFF:
                logger.info("No voice activity detected, using backup VAD model.")
                result = self._do_vad_processing(get_config().vad.backup_vad_model, input_audio, output_audio, game_line)
            if not result.success:
                if get_config().vad.add_audio_on_no_results:
                    logger.info("No voice activity detected, using full audio.")
                    result.output_audio = input_audio
                else:
                    logger.info("No voice activity detected.")
                    return result
            else:
                logger.info(result.trim_successful_string())
            return result


    def _do_vad_processing(self, model, input_audio, output_audio, game_line):
        match model:
            case configuration.OFF:
                return VADResult(False, 0, 0, "OFF")
            case configuration.GROQ:
                if not self.groq:
                    self.groq = GroqVADProcessor()
                return self.groq.process_audio(input_audio, output_audio, game_line)
            case configuration.SILERO:
                if not self.silero:
                    self.silero = SileroVADProcessor()
                return self.silero.process_audio(input_audio, output_audio, game_line)
            case configuration.VOSK:
                if not self.vosk:
                    self.vosk = VoskVADProcessor()
                return self.vosk.process_audio(input_audio, output_audio, game_line)
            case configuration.WHISPER:
                if not self.whisper:
                    self.whisper = WhisperVADProcessor()
                return self.whisper.process_audio(input_audio, output_audio, game_line)

# Base class for VAD systems
class VADProcessor(ABC):
    def __init__(self):
        self.vad_model = None
        self.vad_system_name = None

    @abstractmethod
    def _detect_voice_activity(self, input_audio):
        pass

    @staticmethod
    def extract_audio_and_combine_segments(input_audio, segments, output_audio, padding=0.1):
        files = []
        ffmpeg_threads = []
        logger.info(f"Extracting {len(segments)} segments from {input_audio} with padding {padding} seconds.")

        current_start = None
        for i in range(len(segments)):
            segment = segments[i]
            logger.info(segment)
            if i < len(segments) - 1 and (segments[i + 1]['start'] - segment['end']) < (padding * 2 + padding / 2):
                logger.info(f"Adjusting segment {segments[i + 1]} due to insufficient padding.")
                current_start = segment['start'] if current_start is None else current_start
                continue
            temp_file = make_unique_file_name(
                os.path.join(get_temporary_directory(), "segment." + get_config().audio.extension))
            files.append(temp_file)
            ffmpeg_threads.append(run_new_thread(
                lambda: ffmpeg.trim_audio(input_audio, (current_start if current_start else segment['start']) - (padding * 2), segment['end'] + (padding / 2), temp_file,
                                          trim_beginning=True)))
            current_start = None
            time.sleep(0.1)  # Small delay to ensure unique file names

        for thread in ffmpeg_threads:
            thread.join()

        if len(files) > 1:
            ffmpeg.combine_audio_files(files, output_audio)
            for file in files:
                os.remove(file)
        else:
            shutil.move(files[0], output_audio)


    def process_audio(self, input_audio, output_audio, game_line):
        voice_activity = self._detect_voice_activity(input_audio)

        if not voice_activity:
            logger.info("No voice activity detected in the audio.")
            return VADResult(False, 0, 0, self.vad_system_name)

        start_time = voice_activity[0]['start'] if voice_activity else 0
        end_time = voice_activity[-1]['end'] if voice_activity else 0

        # Attempt to fix the end time if the last segment is too short
        if game_line and game_line.next and len(voice_activity) > 1:
            audio_length = get_audio_length(input_audio)
            if 0 > audio_length - voice_activity[-1]['start'] + get_config().audio.beginning_offset:
                end_time = voice_activity[-2]['end']

        if get_config().vad.cut_and_splice_segments:
            self.extract_audio_and_combine_segments(input_audio, voice_activity, output_audio, padding=get_config().vad.splice_padding)
        else:
            ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio, trim_beginning=get_config().vad.trim_beginning, fade_in_duration=0, fade_out_duration=0)
        return VADResult(True, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, self.vad_system_name, voice_activity, output_audio)

class SileroVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        from silero_vad import load_silero_vad
        self.vad_model = load_silero_vad()
        self.vad_system_name = SILERO

    def _detect_voice_activity(self, input_audio):
        from silero_vad import read_audio, get_speech_timestamps
        temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
        ffmpeg.convert_audio_to_wav(input_audio, temp_wav)
        wav = read_audio(temp_wav)
        speech_timestamps = get_speech_timestamps(wav, self.vad_model, return_seconds=True)
        logger.debug(speech_timestamps)
        return speech_timestamps

class WhisperVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self.vad_model = self.load_whisper_model()
        self.vad_system_name = WHISPER

    def load_whisper_model(self):
        import stable_whisper as whisper
        if not self.vad_model:
            with warnings.catch_warnings(action="ignore"):
                self.vad_model = whisper.load_model(get_config().vad.whisper_model)
            logger.info(f"Whisper model '{get_config().vad.whisper_model}' loaded.")
        return self.vad_model

    def _detect_voice_activity(self, input_audio):
        from stable_whisper import WhisperResult
        # Convert the audio to 16kHz mono WAV
        temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
        ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

        logger.info('transcribing audio...')

        # Transcribe the audio using Whisper
        with warnings.catch_warnings(action="ignore"):
            result: WhisperResult = self.vad_model.transcribe(temp_wav, vad=True, language=get_config().vad.language,
                                                             temperature=0.0)
        voice_activity = []

        logger.debug(result.to_dict())

        # Process the segments to extract tokens, timestamps, and confidence
        for segment in result.segments:
            logger.debug(segment.to_dict())
            voice_activity.append({
                'text': segment.text,
                'start': segment.start,
                'end': segment.end,
                'confidence': segment.avg_logprob
            })
            # for word in segment.words:
            #     logger.debug(word.to_dict())
            #     confidence = word.probability
            #     if confidence > .1:
            #         logger.debug(word)
            #         voice_activity.append({
            #             'text': word.word,
            #             'start': word.start,
            #             'end': word.end,
            #             'confidence': word.probability
            #         })

        # Analyze the detected words to decide whether to use the audio
        should_use = False
        unique_words = set(word['text'] for word in voice_activity)
        if len(unique_words) > 1 or not all(item in ['えー', 'ん'] for item in unique_words):
            should_use = True

        if not should_use:
            return None

        # Return the detected voice activity and the total duration
        return voice_activity

# Add a new class for Vosk-based VAD
class VoskVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        self.vad_model = self._load_vosk_model()
        self.vad_system_name = VOSK

    def _load_vosk_model(self):
        if not self.vad_model:
            import vosk
            vosk_model_path = self._download_and_cache_vosk_model()
            self.vad_model = vosk.Model(vosk_model_path)
            logger.info(f"Vosk model loaded from {vosk_model_path}")
        return self.vad_model

    def _download_and_cache_vosk_model(self, model_dir="vosk_model_cache"):
        # Ensure the cache directory exists
        import requests
        import zipfile
        import tarfile
        if not os.path.exists(os.path.join(get_app_directory(), model_dir)):
            os.makedirs(os.path.join(get_app_directory(), model_dir))

        # Extract the model name from the URL
        model_filename = get_config().vad.vosk_url.split("/")[-1]
        model_path = os.path.join(get_app_directory(), model_dir, model_filename)

        # If the model is already downloaded, skip the download
        if not os.path.exists(model_path):
            logger.info(
                f"Downloading the Vosk model from {get_config().vad.vosk_url}... This will take a while if using large model, ~1G")
            response = requests.get(get_config().vad.vosk_url, stream=True)
            with open(model_path, "wb") as file:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        file.write(chunk)
            logger.info("Download complete.")

        # Extract the model if it's a zip or tar file
        model_extract_path = os.path.join(get_app_directory(), model_dir, "vosk_model")
        if not os.path.exists(model_extract_path):
            logger.info("Extracting the Vosk model...")
            if model_filename.endswith(".zip"):
                with zipfile.ZipFile(model_path, "r") as zip_ref:
                    zip_ref.extractall(model_extract_path)
            elif model_filename.endswith(".tar.gz"):
                with tarfile.open(model_path, "r:gz") as tar_ref:
                    tar_ref.extractall(model_extract_path)
            else:
                logger.info("Unknown archive format. Model extraction skipped.")
            logger.info(f"Model extracted to {model_extract_path}.")
        else:
            logger.info(f"Model already extracted at {model_extract_path}.")

        # Return the path to the actual model folder inside the extraction directory
        extracted_folders = os.listdir(model_extract_path)
        if extracted_folders:
            actual_model_folder = os.path.join(model_extract_path,
                                               extracted_folders[0])  # Assuming the first folder is the model
            return actual_model_folder
        else:
            return model_extract_path  # In case there's no subfolder, return the extraction path directly

    def _detect_voice_activity(self, input_audio):
        import soundfile as sf
        import vosk
        import numpy as np
        # Convert the audio to 16kHz mono WAV
        temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
        ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

        # Initialize recognizer
        with sf.SoundFile(temp_wav) as audio_file:
            recognizer = vosk.KaldiRecognizer(self.vad_model, audio_file.samplerate)
            voice_activity = []

            recognizer.SetWords(True)

            # Process audio in chunks
            while True:
                data = audio_file.buffer_read(4000, dtype='int16')
                if len(data) == 0:
                    break

                # Convert buffer to bytes using NumPy
                data_bytes = np.frombuffer(data, dtype='int16').tobytes()

                if recognizer.AcceptWaveform(data_bytes):
                    pass

            final_result = json.loads(recognizer.FinalResult())
            if 'result' in final_result:
                for word in final_result['result']:
                    if word['conf'] >= 0.90:
                        voice_activity.append({
                            'text': word['word'],
                            'start': word['start'],
                            'end': word['end']
                        })

        # Return the detected voice activity
        return voice_activity

class GroqVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        from groq import Groq
        self.client = Groq(api_key=get_config().ai.groq_api_key)
        self.vad_model = self.load_groq_model()
        self.vad_system_name = GROQ

    def load_groq_model(self):
        if not self.vad_model:
            from groq import Groq
            self.vad_model = Groq()
            logger.info("Groq model loaded.")
        return self.vad_model

    def _detect_voice_activity(self, input_audio):
        try:
            with open(input_audio, "rb") as file:
                transcription = self.client.audio.transcriptions.create(
                    file=(os.path.basename(input_audio), file.read()),
                    model="whisper-large-v3-turbo",
                    response_format="verbose_json",
                    language=get_config().vad.language,
                    temperature=0.0,
                    timestamp_granularities=["segment"],
                    prompt=f"Start detecting speech from the first spoken word. If there is music or background noise, ignore it completely. Be very careful to not hallucinate on silence. If the transcription is anything but language:{get_config().vad.language}, ignore it completely. If the end of the audio seems like the start of a new sentence, ignore it completely.",
                )

            logger.debug(transcription)
            speech_segments = []
            if hasattr(transcription, 'segments'):
                speech_segments = transcription.segments
            elif hasattr(transcription, 'words'):
                speech_segments = transcription.words
            return speech_segments
        except Exception as e:
            logger.error(f"Error detecting voice with Groq: {e}")
            return [], 0.0


vad_processor = VADSystem()

# test_vad = WhisperVADProcessor()
#
# if os.path.exists(r"C:\Users\Beangate\GSM\Electron App\test\after_splice.opus"):
#     os.remove(r"C:\Users\Beangate\GSM\Electron App\test\after_splice.opus")
# get_config().vad.cut_and_splice_segments = True
# get_config().vad.splice_padding = 0.3
# test_vad.process_audio(r"C:\Users\Beangate\GSM\Electron App\test\temp_audio.opus", r"C:\Users\Beangate\GSM\Electron App\test\after_splice.opus", None)