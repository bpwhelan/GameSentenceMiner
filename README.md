# Sentence Mining Game Audio Trim Helper

This project automates the recording of game sentence audio to help with Anki Card Creation. 

You can trigger the entire process with a single hotkey that cuts out the before and after voice, gets a screenshot, and sends both to Anki.


If you run into issues find me on discord @Beangate, or make an issue here. I've used this process to generate ~100 cards from Dragon Quest XI so far and it's worked quite well.


## Features:
- **Azure Speech Recognition**: Automatically cuts the end of the clip to the exact moment the voice ended.
- **OBS Replay Buffer**: Constantly records the last 30 seconds of gameplay.
- **ShareX**: Takes screenshots of the game at the moment of the replay.
- **Clipboard Interaction**: Automatically monitors the clipboard for dialogue events.
- **Hotkey Automation**: Single hotkey to trigger video recording, screenshot, and transcription.

## Prerequisites

- [Python 3.7+](https://www.python.org/downloads/)
- [OBS Studio](https://obsproject.com/)

---

## 1. Setting Up OBS 30-Second Replay Buffer

1. **Install OBS Studio**: Download and install OBS from [here](https://obsproject.com/).
2. **Enable Replay Buffer**:
   1. Open OBS and navigate to **Settings → Output → Replay Buffer**.
   2. Enable the **Replay Buffer** and set the duration to **30 seconds**, this can be lower, or higher, but 30 works for a very simple setup.
3. **Set a Hotkey for the Replay Buffer**:
   1. Go to **Settings → Hotkeys** and find **Save Replay Buffer**.
   2. Assign a hotkey for saving the replay.
4. **Set up obs websocket** (Super Optional)
    1. Can allow my script to automatically start (and stop) the replay buffer.

---

## 2. Configuring `config.py`

Your `config.py` file allows you to configure key settings for the automation process, file paths, and other behavior. Here are the configurable options:

```python
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
```

---

## 3. Example Process

1. Start game
2. Hook Game with Agent (or textractor) with clipboard enabled
3. start script: `python main.py`
   1. Create Anki Card with target word (through a texthooker page/Yomitan)
   2. Trigger Hotkey to record replay buffer
4. When finished gaming, end script

Once the hotkey is triggered:
1. **OBS** will save the last X seconds of gameplay.
2. The Python script will trim the audio based on last clipboard event, and the end of voiceline detected in Vosk if enabled.
3. Will attempt to update the LAST anki card created.

---

## How to Update the Script

To ensure you always have the latest version of this script, you can use `git pull` to update your local repository with the latest changes from the remote repository.

### Step-by-Step Instructions

1. Open your terminal and navigate to the directory where you cloned the repository:
    ```bash
    cd path/to/script
    ```

2. Run the following command to fetch and integrate the latest changes:
    ```bash
    git pull origin master
    ```

    - **`origin`** refers to the remote repository from which you cloned the code.
    - **`master`** refers to the main branch of the repository. If your default branch has a different name (e.g., `main` or `dev`), replace `master` with that branch name.

3. The `git pull` command will download and apply any updates from the remote repository to your local version.

### Example:

```bash
$ cd path/to/script
$ git pull origin master
```

---

## Conclusion

This setup allows you to record key moments in your game automatically, capture screenshots, and transcribe dialogue, all through a simple hotkey. Enjoy automating your gaming content creation!
