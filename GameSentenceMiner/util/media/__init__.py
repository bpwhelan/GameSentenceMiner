from GameSentenceMiner.util.media.ffmpeg import *  # noqa: F401,F403

_AUDIO_PLAYER_EXPORTS = {
    "AudioPlayer",
    "AudioPlayerInterface",
    "NullAudioPlayer",
    "QtAudioPlayer",
    "SoundDeviceAudioPlayer",
}


def __getattr__(name: str):
    if name in _AUDIO_PLAYER_EXPORTS:
        from GameSentenceMiner.util.media import audio_player

        value = getattr(audio_player, name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
