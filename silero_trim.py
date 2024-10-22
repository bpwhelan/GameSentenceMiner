import subprocess
import tempfile
import config_reader
from silero_vad import load_silero_vad, read_audio, get_speech_timestamps
from config_reader import *
from ffmpeg import ffmpeg_base_command, ffmpeg_base_command_list


# Function to convert audio to 16kHz mono WAV if not already in that format
def convert_audio_to_wav(input_audio, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -ar 16000 -ac 1 -af \"afftdn, dialoguenhance\" \"{output_wav}\""
    subprocess.run(command)


# Silero VAD setup
vad_model = load_silero_vad()


# Use Silero to detect voice activity with timestamps in the audio
def detect_voice_with_silero(input_audio):
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=config_reader.temp_directory, suffix='.wav').name
    convert_audio_to_wav(input_audio, temp_wav)

    # Load the audio and detect speech timestamps
    wav = read_audio(input_audio, sampling_rate=16000)
    speech_timestamps = get_speech_timestamps(wav, vad_model, return_seconds=True)

    logger.debug(speech_timestamps)

    # Return the speech timestamps (start and end in seconds)
    return speech_timestamps


# Trim the audio using FFmpeg based on detected speech timestamps
def trim_audio(input_audio, start_time, end_time, output_audio):
    command = ffmpeg_base_command_list.copy()

    if vosk_trim_beginning and start_time > 0:
        command.extend(['-ss', f"{start_time:.2f}"])

    command.extend([
        '-to', f"{end_time:.2f}",
        '-i', input_audio,
        '-c', 'copy',
        output_audio
    ])

    subprocess.run(command)


# Example usage of Silero with trimming
def process_audio_with_silero(input_audio, output_audio):
    voice_activity = detect_voice_with_silero(input_audio)

    if not voice_activity:
        logger.info("No voice activity detected in the audio.")
        return False

    # Trim based on the first and last speech detected
    start_time = voice_activity[0]['start'] if voice_activity else 0
    end_time = voice_activity[-1]['end'] if voice_activity else 0

    # Trim the audio using FFmpeg
    trim_audio(input_audio, start_time, end_time + config_reader.audio_end_offset, output_audio)
    logger.info(f"Trimmed audio saved to: {output_audio}")
    return True
