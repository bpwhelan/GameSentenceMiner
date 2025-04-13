import tarfile
import tempfile
import zipfile

import numpy as np
import requests
import soundfile as sf
import vosk

from GameSentenceMiner  import configuration, ffmpeg
from GameSentenceMiner.configuration import *

ffmpeg_base_command_list = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
vosk.SetLogLevel(-1)
vosk_model_path = ''
vosk_model = None


# Function to download and cache the Vosk model
def download_and_cache_vosk_model(model_dir="vosk_model_cache"):
    # Ensure the cache directory exists
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


# Use Vosk to detect voice activity with timestamps in the audio
def detect_voice_with_vosk(input_audio):
    global vosk_model_path, vosk_model
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
    ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

    if not vosk_model_path or not vosk_model:
        vosk_model_path = download_and_cache_vosk_model()
        vosk_model = vosk.Model(vosk_model_path)

    # Open the audio file
    with sf.SoundFile(temp_wav) as audio_file:
        recognizer = vosk.KaldiRecognizer(vosk_model, audio_file.samplerate)
        voice_activity = []
        total_duration = len(audio_file) / audio_file.samplerate  # Get total duration in seconds

        recognizer.SetWords(True)
        # recognizer.SetPartialWords(True)

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
            should_use = False
            unique_words = set()
            for word in final_result['result']:
                if word['conf'] >= .90:
                    logger.debug(word)
                    should_use = True
                    unique_words.add(word['word'])
            if len(unique_words) == 1 or all(item in ['えー', 'ん'] for item in unique_words):
                should_use = False

            if not should_use:
                return None, 0

            for word in final_result['result']:
                voice_activity.append({
                    'text': word['word'],
                    'start': word['start'],
                    'end': word['end']
                })

    # Return the detected voice activity and the total duration
    return voice_activity, total_duration


# Example usage of Vosk with trimming
def process_audio_with_vosk(input_audio, output_audio):
    voice_activity, total_duration = detect_voice_with_vosk(input_audio)

    if not voice_activity:
        logger.info("No voice activity detected in the audio.")
        return False, 0, 0

    # Trim based on the first and last speech detected
    start_time = voice_activity[0]['start'] if voice_activity else 0
    end_time = voice_activity[-1]['end'] if voice_activity else total_duration

    if get_config().vad.trim_beginning:
        logger.info(f"Trimmed Beginning of Audio to {start_time}")

    # Print detected speech details with timestamps
    logger.info(f"Trimmed End of Audio to {end_time} seconds:")

    # Trim the audio using FFmpeg
    ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio)
    logger.info(f"Trimmed audio saved to: {output_audio}")
    return True, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset


def get_vosk_model():
    global vosk_model_path, vosk_model
    vosk_model_path = download_and_cache_vosk_model()
    vosk_model = vosk.Model(vosk_model_path)
    logger.info(f"Using Vosk model from {vosk_model_path}")
