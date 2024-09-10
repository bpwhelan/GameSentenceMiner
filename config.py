from os.path import expanduser
home = expanduser("~")

# Feel free to adjust these as you please
folder_to_watch = f"{home}/Videos/OBS"
audio_destination = f"{home}/Videos/OBS/Audio/"
screenshot_destination = f"{home}/Videos/OBS/SS/"

current_game = "Dragon Quest XI"  # Automatic in the future maybe?

# Anki Fields
sentence_audio_field = "SentenceAudio"
picture_field = "Picture"
source_field = "Source"

# Feature Flags
do_vosk_postprocessing = True
remove_video = True
update_anki = True
start_obs_replaybuffer = False
# Seems to be faster, but takes a LOT more resources, also is like ~1.5G, If you have a badass PC, go for it
# vosk_model_url = "https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip"

# Default, Use this if you have less than 16G of RAM, or if you have a weaker PC
vosk_model_url = "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip"

