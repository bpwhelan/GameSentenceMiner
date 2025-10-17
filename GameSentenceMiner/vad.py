import json
import logging
import os
import shutil
import tempfile
import time
import warnings
import re
from abc import abstractmethod, ABC

from GameSentenceMiner.util import configuration, ffmpeg
from GameSentenceMiner.util.configuration import get_config, get_temporary_directory, logger, SILERO, WHISPER
from GameSentenceMiner.util.ffmpeg import get_audio_length
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, run_new_thread
from GameSentenceMiner.util.model import VADResult


class VADSystem:
    def __init__(self):
        self.silero = None
        self.whisper = None
        # self.vosk = None
        # self.groq = None

    def init(self):
        if get_config().vad.is_whisper():
            if not self.whisper:
                self.whisper = WhisperVADProcessor()
        if get_config().vad.is_silero():
            if not self.silero:
                self.silero = SileroVADProcessor()
        # if get_config().vad.is_vosk():
        #     if not self.vosk:
        #         self.vosk = VoskVADProcessor()
        # if get_config().vad.is_groq():
        #     if not self.groq:
        #         self.groq = GroqVADProcessor()

    def trim_audio_with_vad(self, input_audio, output_audio, game_line, full_text):
        if get_config().vad.do_vad_postprocessing:
            result = self._do_vad_processing(get_config().vad.selected_vad_model, input_audio, output_audio, game_line, full_text)
            if not result.success and get_config().vad.backup_vad_model != configuration.OFF:
                logger.info("No voice activity detected, using backup VAD model.")
                result = self._do_vad_processing(get_config().vad.backup_vad_model, input_audio, output_audio, game_line, full_text)
            return result

    def _do_vad_processing(self, model, input_audio, output_audio, game_line, text_mined):
        match model:
            case configuration.OFF:
                return VADResult(False, 0, 0, "OFF")
            case configuration.SILERO:
                if not self.silero:
                    self.silero = SileroVADProcessor()
                return self.silero.process_audio(input_audio, output_audio, game_line, text_mined)
            case configuration.WHISPER:
                if not self.whisper:
                    self.whisper = WhisperVADProcessor()
                return self.whisper.process_audio(input_audio, output_audio, game_line, text_mined)

# Base class for VAD systems
class VADProcessor(ABC):
    def __init__(self):
        self.vad_model = None
        self.vad_system_name = None

    @abstractmethod
    def _detect_voice_activity(self, input_audio, text_mined):
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


    def process_audio(self, input_audio, output_audio, game_line, text_mined):
        voice_activity = self._detect_voice_activity(input_audio, text_mined)
        text_similarity = 0

        if voice_activity and isinstance(voice_activity, tuple):
            voice_activity, text_similarity = voice_activity

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

        # if detected text is much shorter than game_line.text, if no text, guess based on length, only check if text_similarity is low
        if text_similarity < 50:
            if 'text' in voice_activity[0]:
                detected_text = ''.join([item['text'] for item in voice_activity])
                if game_line and game_line.text and len(detected_text) < len(game_line.text) / 4:
                    logger.info(f"Detected text '{detected_text}' is much shorter than expected '{game_line.text}', skipping.")
                    return VADResult(False, 0, 0, self.vad_system_name)
            else:
                if game_line and game_line.text and (end_time - start_time) < max(0.5, len(game_line.text) * 0.05):
                    logger.info(f"Detected audio length {end_time - start_time} is much shorter than expected for text '{game_line.text}', skipping.")
                    return VADResult(False, 0, 0, self.vad_system_name)

        if get_config().vad.cut_and_splice_segments:
            self.extract_audio_and_combine_segments(input_audio, voice_activity, output_audio, padding=get_config().vad.splice_padding)
        else:
            ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio, trim_beginning=get_config().vad.trim_beginning, fade_in_duration=0.05, fade_out_duration=0)
        return VADResult(True, max(0, start_time + get_config().vad.beginning_offset), max(0, end_time + get_config().audio.end_offset), self.vad_system_name, voice_activity, output_audio)

class SileroVADProcessor(VADProcessor):
    def __init__(self):
        super().__init__()
        from silero_vad import load_silero_vad
        self.vad_model = load_silero_vad()
        self.vad_system_name = SILERO

    def _detect_voice_activity(self, input_audio, text_mined):
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
        import torch
        if not self.vad_model:
            self.device = "cpu" if get_config().vad.use_cpu_for_inference else "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float32" if torch.cuda.is_available() else "int8"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                logger.info(f"Loading Whisper model '{get_config().vad.whisper_model}' on device '{self.device}'...")
                self.vad_model = whisper.load_faster_whisper(get_config().vad.whisper_model, device=self.device, compute_type=compute_type)
            logger.info(f"Whisper model '{get_config().vad.whisper_model}' loaded.")
        return self.vad_model

    def _detect_voice_activity(self, input_audio, text_mined):
        from stable_whisper import WhisperResult
        # Convert the audio to 16kHz mono WAV, evidence https://discord.com/channels/1286409772383342664/1286518821913362445/1407017127529152533
        temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
        ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

        logger.info('transcribing audio...')

        # Transcribe the audio using Whisper
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result: WhisperResult = self.vad_model.transcribe(temp_wav, vad=True, language=get_config().vad.language, vad_filter=get_config().vad.use_vad_filter_for_whisper,
                                                             temperature=0.0, chunk_length=60)
        voice_activity = []

        logger.debug(json.dumps(result.to_dict()))
        
        text = result.text.strip()
        text_similarity = 0
        
        # If both mined text and Whisper transcription are available, compare their similarity
        if text_mined and text:
            from rapidfuzz import fuzz
            similarity = fuzz.ratio(text_mined, text)
            logger.info(f"Whisper transcription: '{text}' | Mined text: '{text_mined}' | Full similarity: {similarity:.1f}")
            text_similarity = similarity
            if similarity < 20:
                logger.info(f"Full similarity {similarity:.1f} is below threshold, skipping voice activity.")
                return []

        # Process the segments to extract tokens, timestamps, and confidence
        previous_segment = None
        for i, segment in enumerate(result.segments):
            if len(segment.text) <= 2 and ((i > 1 and segment.start - result.segments[i - 1].end > 1.0) or (i < len(result.segments) - 1 and result.segments[i + 1].start - segment.end > 1.0)):
                if segment.text in ['えー', 'ん']:
                        logger.debug(f"Skipping filler segment: {segment.text} at {segment.start}-{segment.end}")
                        continue
                else:
                    logger.info(
                        "Unknown single character segment, not skipping, but logging, please report if this is a mistake: " + segment.text)
                
            # Skip segments with excessive repeating sequences of at least 3 characters
            match = re.search(r'(.{3,})\1{4,}', segment.text)
            if match:
                logger.debug(f"Skipping segment with excessive repeating sequence (>=5): '{segment.text}' at {segment.start}-{segment.end}. Likely Hallucination.")
                continue
                    
            if segment.no_speech_prob and segment.no_speech_prob > 0.9:
                logger.debug(f"Skipping segment with high no_speech_prob: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}")
                continue
            
            unique_words = set(word.word for word in segment.words)
            if len(unique_words) <= 1 and len(segment.words) > 1:
                logger.debug(f"Skipping segment with low unique words: {unique_words} for segment {segment.text} at {segment.start}-{segment.end}")
                continue
                
            if segment.seek > 0 and segment.no_speech_prob > .3:
                logger.debug(f"Skipping segment after long pause with high no_speech_prob after: {segment.no_speech_prob} for segment {segment.text} at {segment.start}-{segment.end}")
                continue

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

            previous_segment = segment
        # Return the detected voice activity and the total duration
        return voice_activity, text_similarity

# Add a new class for Vosk-based VAD
# class VoskVADProcessor(VADProcessor):
#     def __init__(self):
#         super().__init__()
#         self.vad_model = self._load_vosk_model()
#         self.vad_system_name = VOSK
#
#     def _load_vosk_model(self):
#         if not self.vad_model:
#             import vosk
#             vosk_model_path = self._download_and_cache_vosk_model()
#             self.vad_model = vosk.Model(vosk_model_path)
#             logger.info(f"Vosk model loaded from {vosk_model_path}")
#         return self.vad_model
#
#     def _download_and_cache_vosk_model(self, model_dir="vosk_model_cache"):
#         # Ensure the cache directory exists
#         import requests
#         import zipfile
#         import tarfile
#         if not os.path.exists(os.path.join(get_app_directory(), model_dir)):
#             os.makedirs(os.path.join(get_app_directory(), model_dir))
#
#         # Extract the model name from the URL
#         model_filename = get_config().vad.vosk_url.split("/")[-1]
#         model_path = os.path.join(get_app_directory(), model_dir, model_filename)
#
#         # If the model is already downloaded, skip the download
#         if not os.path.exists(model_path):
#             logger.info(
#                 f"Downloading the Vosk model from {get_config().vad.vosk_url}... This will take a while if using large model, ~1G")
#             response = requests.get(get_config().vad.vosk_url, stream=True)
#             with open(model_path, "wb") as file:
#                 for chunk in response.iter_content(chunk_size=8192):
#                     if chunk:
#                         file.write(chunk)
#             logger.info("Download complete.")
#
#         # Extract the model if it's a zip or tar file
#         model_extract_path = os.path.join(get_app_directory(), model_dir, "vosk_model")
#         if not os.path.exists(model_extract_path):
#             logger.info("Extracting the Vosk model...")
#             if model_filename.endswith(".zip"):
#                 with zipfile.ZipFile(model_path, "r") as zip_ref:
#                     zip_ref.extractall(model_extract_path)
#             elif model_filename.endswith(".tar.gz"):
#                 with tarfile.open(model_path, "r:gz") as tar_ref:
#                     tar_ref.extractall(model_extract_path)
#             else:
#                 logger.info("Unknown archive format. Model extraction skipped.")
#             logger.info(f"Model extracted to {model_extract_path}.")
#         else:
#             logger.info(f"Model already extracted at {model_extract_path}.")
#
#         # Return the path to the actual model folder inside the extraction directory
#         extracted_folders = os.listdir(model_extract_path)
#         if extracted_folders:
#             actual_model_folder = os.path.join(model_extract_path,
#                                                extracted_folders[0])  # Assuming the first folder is the model
#             return actual_model_folder
#         else:
#             return model_extract_path  # In case there's no subfolder, return the extraction path directly
#
#     def _detect_voice_activity(self, input_audio):
#         import soundfile as sf
#         import vosk
#         import numpy as np
#         # Convert the audio to 16kHz mono WAV
#         temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
#         ffmpeg.convert_audio_to_wav(input_audio, temp_wav)
#
#         # Initialize recognizer
#         with sf.SoundFile(temp_wav) as audio_file:
#             recognizer = vosk.KaldiRecognizer(self.vad_model, audio_file.samplerate)
#             voice_activity = []
#
#             recognizer.SetWords(True)
#
#             # Process audio in chunks
#             while True:
#                 data = audio_file.buffer_read(4000, dtype='int16')
#                 if len(data) == 0:
#                     break
#
#                 # Convert buffer to bytes using NumPy
#                 data_bytes = np.frombuffer(data, dtype='int16').tobytes()
#
#                 if recognizer.AcceptWaveform(data_bytes):
#                     pass
#
#             final_result = json.loads(recognizer.FinalResult())
#             if 'result' in final_result:
#                 for word in final_result['result']:
#                     if word['conf'] >= 0.90:
#                         voice_activity.append({
#                             'text': word['word'],
#                             'start': word['start'],
#                             'end': word['end']
#                         })
#
#         # Return the detected voice activity
#         return voice_activity

# class GroqVADProcessor(VADProcessor):
#     def __init__(self):
#         super().__init__()
#         self.client = self.load_groq_model()
#         self.vad_system_name = GROQ
#
#     def load_groq_model(self):
#         if not hasattr(self, 'client') or not self.client:
#             from groq import Groq
#             client = Groq(api_key=get_config().ai.groq_api_key)
#             logger.info("Groq model loaded.")
#             return client
#         return self.client
#
#     def _detect_voice_activity(self, input_audio):
#         try:
#             with open(input_audio, "rb") as file:
#                 transcription = self.client.audio.transcriptions.create(
#                     file=(os.path.basename(input_audio), file.read()),
#                     model="whisper-large-v3-turbo",
#                     response_format="verbose_json",
#                     language=get_config().vad.language,
#                     temperature=0.0,
#                     timestamp_granularities=["segment"],
#                     prompt=f"Start detecting speech from the first spoken word. If there is music or background noise, ignore it completely. Be very careful to not hallucinate on silence. If the transcription is anything but language:{get_config().vad.language}, ignore it completely. If the end of the audio seems like the start of a new sentence, ignore it completely.",
#                 )
#
#             logger.debug(transcription)
#             speech_segments = []
#             if hasattr(transcription, 'segments'):
#                 speech_segments = transcription.segments
#             elif hasattr(transcription, 'words'):
#                 speech_segments = transcription.words
#             return speech_segments
#         except Exception as e:
#             logger.error(f"Error detecting voice with Groq: {e}")
#             return [], 0.0


vad_processor = VADSystem()

# Test cases for all VADProcessors
def test_vad_processors():
    logger.setLevel(logging.DEBUG)
    test_audio = r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\NEKOPARAvol.1_2025-08-18-17-20-43-614.opus"
    output_dir = r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\output"
    os.makedirs(output_dir, exist_ok=True)
    processors = [
        (WhisperVADProcessor(), "after_splice_whisper.opus"),
        (SileroVADProcessor(), "after_splice_silero.opus"),
        # (VoskVADProcessor(), "after_splice_vosk.opus"),
        # (GroqVADProcessor(), "after_splice_groq.opus"),
    ]
    # get_config().vad.cut_and_splice_segments = True
    # get_config().vad.splice_padding = 0.3
    # for processor, out_name in processors:
    #     logger.info("Testing Splice Audio with " + processor.vad_system_name)
    #     out_path = os.path.join(output_dir, out_name)
    #     if os.path.exists(out_path):
    #         os.remove(out_path)
    #     processor.process_audio(test_audio, out_path, None)

    get_config().vad.cut_and_splice_segments = False
    get_config().vad.trim_beginning = True
    get_config().vad.add_audio_on_no_results = True
    get_config().vad.use_vad_filter_for_whisper = False
    for processor, out_name in processors:
        logger.info("Testing Trim Audio with " + processor.vad_system_name)
        out_path = os.path.join(output_dir, out_name.replace("after_splice_", "after_trim_"))
        if os.path.exists(out_path):
            os.remove(out_path)
        result = processor.process_audio(test_audio, out_path, None, "")
        print(result)
        
    vad_system = VADSystem()
    vad_system.init()
    
    result = vad_system.trim_audio_with_vad(test_audio, os.path.join(output_dir, "after_vad.opus"), None, full_text="")
    print(result)


if __name__ == "__main__":
    test_vad_processors()