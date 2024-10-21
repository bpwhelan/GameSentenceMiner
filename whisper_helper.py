import subprocess
import tempfile
import warnings

import stable_whisper as whisper
from stable_whisper import WhisperResult

import config_reader
from config_reader import *

ffmpeg_base_command = "ffmpeg -hide_banner -loglevel error"
ffmpeg_base_command_list = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
whisper_model = None


# # Convert audio to 16kHz mono WAV (Whisper expects this format)
def convert_audio_to_wav(input_audio, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -ar 16000 -ac 1 -af \"afftdn, dialoguenhance\" \"{output_wav}\""
    subprocess.run(command)


# Function to download and load the Whisper model
def load_whisper_model():
    global whisper_model
    if whisper_model is None:
        logger.info(f"Loading Whisper model '{whisper_model_name}'... This may take a while.")
        with warnings.catch_warnings(action="ignore"):
            whisper_model = whisper.load_model(whisper_model_name)
        logger.info("Whisper model loaded.")


# Use Whisper to detect voice activity with timestamps in the audio
def detect_voice_with_whisper(input_audio):
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=config_reader.temp_directory, suffix='.wav').name
    convert_audio_to_wav(input_audio, temp_wav)

    # Make sure Whisper is loaded
    load_whisper_model()

    logger.info('transcribing audio...')

    # Transcribe the audio using Whisper
    with warnings.catch_warnings(action="ignore"):
        result: WhisperResult = whisper_model.transcribe(temp_wav, vad=True, language='ja')

    voice_activity = []

    logger.debug(result.to_dict())

    # Process the segments to extract tokens, timestamps, and confidence
    for segment in result.segments:
        logger.debug(segment.to_dict())
        for word in segment.words:
            logger.debug(word.to_dict())
            confidence = word.probability
            if confidence > .1:
                logger.debug(word)
                voice_activity.append({
                    'text': word.word,
                    'start': word.start,
                    'end': word.end,
                    'confidence': word.probability
                })


    # Process the segments to extract tokens, timestamps, and confidence
    # for segment in result['segments']:
    #     logger.debug(segment)
    #     for word in segment['words']:
    #         confidence = word.get('probability', 1.0)
    #         if confidence > .1:
    #             logger.debug(word)
    #             voice_activity.append({
    #                 'text': word['word'],
    #                 'start': word['start'],
    #                 'end': word['end'],
    #                 'confidence': word.get('probability', 1.0)  # Default confidence to 1.0 if not available
    #             })
    # Analyze the detected words to decide whether to use the audio
    should_use = False
    unique_words = set(word['text'] for word in voice_activity)
    if len(unique_words) > 1 or not all(item in ['えー', 'ん'] for item in unique_words):
        should_use = True

    if not should_use:
        return None

    # Return the detected voice activity and the total duration
    return voice_activity


# Trim the audio using FFmpeg based on detected speech timestamps
def trim_audio(input_audio, start_time, end_time, output_audio):
    command = ffmpeg_base_command_list.copy()

    if vosk_trim_beginning:
        command.extend(['-ss', f"{start_time - .25:.2f}"])

    command.extend([
        '-to', f"{end_time:.2f}",
        '-i', input_audio,
        '-c', 'copy',
        output_audio
    ])

    print(command)

    subprocess.run(command)


# Example usage of Whisper with trimming
def process_audio_with_whisper(input_audio, output_audio):
    voice_activity = detect_voice_with_whisper(input_audio)

    if not voice_activity:
        logger.info("No voice activity detected in the audio.")
        return False

    # Trim based on the first and last speech detected
    start_time = voice_activity[0]['start']
    end_time = voice_activity[-1]['end']

    if vosk_trim_beginning:
        logger.info(f"Trimmed Beginning of Audio to {start_time}")

    # Print detected speech details with timestamps
    logger.info(f"Trimmed End of Audio to {end_time} seconds:")

    # Trim the audio using FFmpeg
    trim_audio(input_audio, start_time, end_time + config_reader.audio_end_offset, output_audio)
    logger.info(f"Trimmed audio saved to: {output_audio}")
    return True


# Load Whisper model initially
def initialize_whisper_model():
    load_whisper_model()
    logger.info(f"Using Whisper model '{whisper_model_name}' for Japanese voice detection")