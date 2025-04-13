import tempfile

from silero_vad import load_silero_vad, read_audio, get_speech_timestamps

from GameSentenceMiner  import configuration, ffmpeg
from GameSentenceMiner.configuration import *

# Silero VAD setup
vad_model = load_silero_vad()


# Use Silero to detect voice activity with timestamps in the audio
def detect_voice_with_silero(input_audio):
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
    ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

    # Load the audio and detect speech timestamps
    wav = read_audio(temp_wav, sampling_rate=16000)
    speech_timestamps = get_speech_timestamps(wav, vad_model, return_seconds=True)

    logger.debug(speech_timestamps)

    # Return the speech timestamps (start and end in seconds)
    return speech_timestamps


# Example usage of Silero with trimming
def process_audio_with_silero(input_audio, output_audio):
    voice_activity = detect_voice_with_silero(input_audio)

    if not voice_activity:
        logger.info("No voice activity detected in the audio.")
        return False, 0, 0

    # Trim based on the first and last speech detected
    start_time = voice_activity[0]['start'] if voice_activity else 0
    end_time = voice_activity[-1]['end'] if voice_activity else 0

    # Trim the audio using FFmpeg
    ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio)
    logger.info(f"Trimmed audio saved to: {output_audio}")
    return True, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset
