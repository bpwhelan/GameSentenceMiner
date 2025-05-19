import subprocess

from GameSentenceMiner.ffmpeg import get_ffprobe_path


def get_audio_length(path):
    result = subprocess.run(
        [get_ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    return float(result.stdout.strip())