import os
import tempfile
import time

from groq import Groq

# Assuming these are available from GameSentenceMiner
from GameSentenceMiner import configuration, ffmpeg
from GameSentenceMiner.configuration import get_config, logger, GROQ  # Import specific functions/objects
from GameSentenceMiner.vad.result import VADResult
from GameSentenceMiner.vad.vad_utils import get_audio_length

# Initialize Groq Client
client = Groq(api_key=get_config().ai.groq_api_key)

def detect_voice_with_groq(input_audio_path):
    """
    Detects voice activity and extracts speech timestamps using the Groq Whisper API.
    """
    try:
        with open(input_audio_path, "rb") as file:
            transcription = client.audio.transcriptions.create(
                file=(os.path.basename(input_audio_path), file.read()),
                model="whisper-large-v3-turbo",
                response_format="verbose_json",
                language=get_config().vad.language,
                temperature=0.0,
                timestamp_granularities=["segment"],
                prompt=f"Start detecting speech from the first spoken word. If there is music or background noise, ignore it completely. Be very careful to not hallucinate on silence. If the transcription is anything but language:{get_config().vad.language}, ignore it completely. If the end of the audio seems like the start of a new sentence, ignore it completely.",
            )

        logger.debug(transcription)

        # print(transcription)

        speech_segments = transcription.segments if hasattr(transcription, 'segments') else []
        # print(f"Groq speech segments: {speech_segments}")

        audio_length = get_audio_length(input_audio_path)
        # print(f"FFPROBE Length of input audio: {audio_length}")

        return speech_segments, audio_length
    except Exception as e:
        logger.error(f"Error detecting voice with Groq: {e}")
        return [], 0.0

def process_audio_with_groq(input_audio, output_audio, game_line):
    """
    Processes an audio file by detecting voice activity using Groq Whisper API,
    trimming the audio based on detected speech timestamps, and saving the trimmed audio.
    """
    start = time.time()
    voice_activity, audio_length = detect_voice_with_groq(input_audio)
    logger.info(f"Processing time for Groq: {time.time() - start:.2f} seconds")

    if not voice_activity:
        logger.info(f"No voice activity detected in {input_audio}")
        return VADResult(False, 0, 0, GROQ)

    start_time = voice_activity[0]['start']
    end_time = voice_activity[-1]['end']

    # Logic to potentially use the second-to-last timestamp if a next game line is expected
    # and there's a significant pause before the very last segment.
    if (game_line and hasattr(game_line, 'next') and game_line.next and
        len(voice_activity) > 1 and
        (voice_activity[-1]['start'] - voice_activity[-2]['end']) > 3.0):
        end_time = voice_activity[-2]['end']
        logger.info("Using the second last timestamp for trimming due to game_line.next and significant pause.")

    # Apply offsets from configuration, ensuring times are within valid bounds
    final_start_time = max(0, start_time + get_config().vad.beginning_offset)
    final_end_time = min(audio_length, end_time + get_config().audio.end_offset)

    logger.debug(f"Trimming {input_audio} from {final_start_time:.2f}s to {final_end_time:.2f}s into {output_audio}")

    ffmpeg.trim_audio(input_audio, final_start_time, final_end_time, output_audio)

    return VADResult(True, final_start_time, final_end_time, GROQ)

# Example usage (uncomment and modify with your actual file paths for testing)
# process_audio_with_groq("tmp6x81cy27.opus", "tmp6x81cy27_trimmed_groq.opus", None)