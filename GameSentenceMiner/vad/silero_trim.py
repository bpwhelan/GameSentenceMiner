import tempfile

from silero_vad import load_silero_vad, read_audio, get_speech_timestamps

from GameSentenceMiner  import configuration, ffmpeg
from GameSentenceMiner.configuration import *
from GameSentenceMiner.vad.result import VADResult
from GameSentenceMiner.vad.vad_utils import get_audio_length

# Silero VAD setup
vad_model = load_silero_vad()


# Use Silero to detect voice activity with timestamps in the audio
def detect_voice_with_silero(input_audio):
    # Convert the audio to 16kHz mono WAV
    temp_wav = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(), suffix='.wav').name
    ffmpeg.convert_audio_to_wav(input_audio, temp_wav)

    # Load the audio and detect speech timestamps
    wav = read_audio(temp_wav)
    speech_timestamps = get_speech_timestamps(wav, vad_model, return_seconds=True)

    logger.debug(speech_timestamps)

    # Return the speech timestamps (start and end in seconds)
    return speech_timestamps, len(wav) / 16000


# Example usage of Silero with trimming
def process_audio_with_silero(input_audio, output_audio, game_line):
    voice_activity, audio_length = detect_voice_with_silero(input_audio)

    if not voice_activity:
        return VADResult(False, 0, 0, SILERO)

    # Trim based on the first and last speech detected
    start_time = voice_activity[0]['start'] if voice_activity else 0
    if game_line and game_line.next and len(voice_activity) > 1 and 0 > get_config().audio.beginning_offset > audio_length - voice_activity[-1]['start']:
    #         and (voice_activity[-1]['start'] - voice_activity[-2]['end']) > 3.0):
            end_time = voice_activity[-2]['end']
            logger.info("Using the second last timestamp for trimming")
    else:
        end_time = voice_activity[-1]['end'] if voice_activity else 0

    # Trim the audio using FFmpeg
    ffmpeg.trim_audio(input_audio, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, output_audio)
    return VADResult(True, start_time + get_config().vad.beginning_offset, end_time + get_config().audio.end_offset, SILERO)


# process_audio_with_silero("tmp6x81cy27.opus", "tmp6x81cy27_trimmed.opus", None)
# print(detect_voice_with_silero("tmp6x81cy27.opus"))