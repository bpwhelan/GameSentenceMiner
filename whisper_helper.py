import subprocess
import tempfile

import whisper

import config_reader
from config_reader import *

ffmpeg_base_command = "ffmpeg -hide_banner -loglevel error"
ffmpeg_base_command_list = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
whisper_model_name = 'base'  # Choose the appropriate Whisper model (tiny, base, small, medium, large)
whisper_model = None


# Convert audio to 16kHz mono WAV (Whisper expects this format)
def convert_audio_to_wav(input_audio, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -ar 16000 -ac 1 \"{output_wav}\""
    subprocess.run(command)


# Function to download and load the Whisper model
def load_whisper_model():
    global whisper_model
    if whisper_model is None:
        logger.info(f"Loading Whisper model '{whisper_model_name}'... This may take a while.")
        whisper_model = whisper.load_model(whisper_model_name)
        logger.info("Whisper model loaded.")


# Use Whisper to detect voice activity with timestamps in the audio
def detect_voice_with_whisper(input_audio):
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=config_reader.temp_directory, suffix='.wav').name
    convert_audio_to_wav(input_audio, temp_wav)

    # Load the Whisper model
    load_whisper_model()

    # Transcribe the audio using Whisper
    result = whisper_model.transcribe(temp_wav, language='ja')

    voice_activity = []

    # Process the segments to extract tokens, timestamps, and confidence
    for segment in result['segments']:
        print(segment)
        voice_activity.append({
            'text': segment['text'],
            'start': segment['start'],
            'end': segment['end'],
            'confidence': segment.get('confidence', 1.0)  # Default confidence to 1.0 if not available
        })
    # Analyze the detected words to decide whether to use the audio
    should_use = False
    unique_words = set(word['text'] for word in voice_activity)
    if len(unique_words) > 1 or not all(item in ['えー', 'ん'] for item in unique_words):
        should_use = True

    if not should_use:
        return None, 0

    # Return the detected voice activity and the total duration
    return voice_activity


# Trim the audio using FFmpeg based on detected speech timestamps
def trim_audio(input_audio, start_time, end_time, output_audio):
    command = ffmpeg_base_command_list.copy()

    if vosk_trim_beginning:
        command.extend(['-ss', str(start_time)])

    command.extend([
        '-i', input_audio,
        '-to', str(end_time),
        '-c', 'copy',
        output_audio
    ])

    subprocess.call(command)


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