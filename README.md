# Sentence Mining Game Audio Trim Helper

This project automates the recording of game sentence audio to help with Anki Card Creation. 

You can trigger the entire process with a single hotkey that cuts out the before and after voice, gets a screenshot, and sends both to Anki.

## Features:
- **Vosk Speech Recognition**: Automatically cuts the end of the clip to the exact moment the voice ended.
- **OBS Replay Buffer**: Constantly records the last X seconds of gameplay.
- **Clipboard Interaction**: Automatically monitors the clipboard for dialogue events.
- **Hotkey Automation**: Single hotkey to trigger video recording, screenshot, and transcription.
- **1-Click Card Creation**: Monitors anki for new cards from Yomitan, and automatically gets audio from games.

## Prerequisites

- [Python 3.11+](https://www.python.org/downloads/)
- [OBS Studio](https://obsproject.com/)

---

### Quick Disclaimer/Troubleshooting

Every game/hook is different, so it's really improbable that any script can get it perfect everytime. Also OBS is sometimes a bit finnicky if running for too long. If the audio timing is off, please first try some troubleshooting steps before making an issue:
- Try Restarting OBS
- Make sure your hook is the best you can find. (Preferrably it gives you the text RIGHT when the voiceline starts)
- Try Adjusting Offset Configuration in `config.toml` to better match your situation. (i.e. if the hook is late, add a negative beginning offset)

#### Setup Troubleshooting

Just going to continuously update this with issues that I have helped users with. Look here first if you have issues setting it up.
- Make sure folder_to_watch is the same as your recordings path in OBS. It defaults to ~/Videos, but I highly setting it to ~/Videos/OBS.
- if it says something about a missing library, attempt to run `pip install -r requirements.txt` again
- Make sure copying to clipboard is ENABLED if using Agent. And "copy to clipboard" extension is installed in Textractor.

## 1. Setting Up OBS 60-Second Replay Buffer

1. **Install OBS Studio**: Download and install OBS from [here](https://obsproject.com/).
2. **Enable Replay Buffer**:
   1. Open OBS and navigate to **Settings → Output → Replay Buffer**.
   2. Enable the **Replay Buffer** and set the duration to **60 seconds**, this can be lower, or higher, but 60 works for a very simple setup.
3. **Set a Hotkey for the Replay Buffer**:
   1. Go to **Settings → Hotkeys** and find **Save Replay Buffer**.
   2. Assign a hotkey for saving the replay.
4. Set Scene/Source. I recommend using "Game Capture" with "Capture Audio" Enabled. And then mute Desktop/microphone
   1. If "Game Capture" Does not work, use "screen capture" with a second source "Application Audio Capture"
5. In Output Settings, set "Recording Format" to mkv, and "Audio Encoder" to Opus. Alternative Settings may be supported at a later date.
6. **Set up obs websocket** (HIGHLY RECOMMENDED see #5)
    1. Can allow my script to automatically start (and stop) the replay buffer, as well as automatically add audio/screenshot to card created from yomi.


Here are the Settings I recommend in OBS. Make sure the recordings folder is the same as the "folder_to_watch" in the `config.toml`
![image](https://github.com/user-attachments/assets/0056816d-af3c-4a3c-bc6a-4aff5c28cadb)
![image](https://github.com/user-attachments/assets/dd2f95a6-f546-41d9-8136-de7b1b035a5d)


---

## 2. Configuring `config.toml`

I redid the config parsing cause `config.py` is not ideal, especially when distributing a script via git.

Your `config.toml` file allows you to configure key settings for the automation process, file paths, and other behavior. Here are the configurable options:

Duplicate/rename config_EXAMPLE.toml to get started

```toml
# Path configurations
[paths]
folder_to_watch = "~/Videos/OBS"
audio_destination = "~/Videos/OBS/Audio/"
screenshot_destination = "~/Videos/OBS/SS/"

# Anki Fields
[anki]
url = 'http://127.0.0.1:8765'
sentence_audio_field = "SentenceAudio"
picture_field = "Picture"
word_field = "Word"
current_game = "Japanese Game"
custom_tags = ['JapaneseGameMiner', "Test Another Tag"] # leave Empty if you dont want to add tags
add_game_tag = true

# Feature Flags
[features]
do_vosk_postprocessing = true
update_anki = true
remove_video = true
remove_screenshot = false
remove_audio = false
notify_on_update = true
open_anki_edit = false

# Vosk Model
[vosk]
url = "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip"
# If you have a high-performance PC, with 16GB+ of RAM, you can uncomment and use this model:
# url = "https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip"
log-level = -1

[screenshot]
width = 0 # Desired Width of Screenshot, 0 to disable scaling (Default 0)
quality = 85 # Quality of image, 100 is lossless (Default 85)
extension = "webp" # Codec of screenshot, Recommend Keeping this as webp (Default webp)

[audio]
extension = "opus" # Desired Extension/codec of Trimmed Audio, (Default opus)
beginning_offset = 0.0 # Negative Value = More time at the beginning (i.e. -1 is 1 extra second at the beginning)
end_offset = 0.5 # Positive Value = More time at the end (i.e. 1 is 1 extra second at the end)
vosk_trim_beginning = false # Only change If you run into issues with clipboard timing, add a negative beginning_offset as well, Warning: You may end up with audio from previous line depending on your setup!

[obs]
enabled = true
start_buffer = true
full_auto_mode = false # Automatically Create Cards when you Create in Yomi. REQUIRED for multi-card-per-voiceline
host = "localhost"
port = 4455
password = "your_password_here"
get_game_from_scene = false
```


---

## 3. Install Requirements

If you know what you are doing, do this in a venv, but I'm not going to explain that here.

`pip install -r requirements.txt`

## 4. Installing FFmpeg

To run this script, you will need to have **FFmpeg** installed. If you don't have FFmpeg installed on your system, you can easily install it via **Chocolatey** (Preferred), or install it yourself and ensure it's in the PATH.

#### Step-by-Step Instructions:

1. First, ensure you have **Chocolatey** installed. If you don't have it installed, follow the instructions on the [Chocolatey installation page](https://chocolatey.org/install) or run the following command in an **elevated** PowerShell window (run as Administrator):
   
   ```bash
   Set-ExecutionPolicy Bypass -Scope Process -Force; `
   [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; `
   iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
   ```

2. Once Chocolatey is installed, open a **new** PowerShell or Command Prompt window (with administrator rights).

3. Run the following command to install FFmpeg:

   ```bash
   choco install ffmpeg
   ```

4. After the installation is complete, verify that FFmpeg is correctly installed by running the following command:

   ```bash
   ffmpeg -version
   ```

   If the installation was successful, you should see the version information for FFmpeg.

Now you're ready to use FFmpeg in the script!


---

## 5. One Click Card Creation

With the Latest Update it is now possible to do full 1-click card creation with this tool + Yomitan. This is configured in the `obs` section in your `config.toml`

Demo: https://www.youtube.com/watch?v=9dmmXO2CGNw

Screenshots to help with setup:

![image](https://github.com/user-attachments/assets/7de031e9-ce28-42eb-a8fd-0e60ef70dc3d)

![image](https://github.com/user-attachments/assets/b0c70a1a-65b5-4fe7-a7e4-ccb0b9a5b249)

![image](https://github.com/user-attachments/assets/4cf492eb-12a2-429f-aa0e-f87fc0fa6270)


## 6. Example Process

1. Start game
2. Hook Game with Agent (or textractor) with clipboard enabled
3. start script: `python main.py`
   1. Create Anki Card with target word (through a texthooker page/Yomitan)
   2. (If full-auto-mode not on) Trigger Hotkey to record replay buffer
4. When finished gaming, end script

Once the hotkey is triggered:
1. **OBS** will save the last X seconds of gameplay.
2. The Python script will trim the audio based on last clipboard event, and the end of voiceline detected in Vosk if enabled.
3. Will attempt to update the LAST anki card created.

---

## How to Update the Script

### Updater (Preferred)

There is now an Update script included! running `python update.py` in the directory will attempt to update your scripts to the latest release. If you have made changes to any of the files, they will be safely backed up before being replaced.

---

### Manual

To ensure you always have the latest version of this script, you can use `git pull` to update your local repository with the latest changes from the remote repository.

#### Step-by-Step Instructions

1. Open your terminal and navigate to the directory where you cloned the repository:
    ```bash
    cd path/to/script
    ```

2. Run the following command to fetch and integrate the latest changes:
    ```bash
    git pull origin main
    ```

    - **`origin`** refers to the remote repository from which you cloned the code.
    - **`main`** refers to the main branch of the repository. If your default branch has a different name (e.g., `master` or `dev`), replace `main` with that branch name.

3. The `git pull` command will download and apply any updates from the remote repository to your local version.

### Example:

```bash
$ cd path/to/script
$ git pull origin master
```

---

## Contact

If you run into issues ask in my [discord](https://discord.gg/yP8Qse6bb8), or make an issue here.

## Donations

If you've benefited from this or any of my other projects, please consider supporting my work via [Github Sponsors](https://github.com/sponsors/bpwhelan) or [Ko-fi.](https://ko-fi.com/beangate)
