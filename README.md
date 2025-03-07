# Game Sentence Miner

This project automates the recording of game sentence audio to help with Anki Card Creation.

This allows us to create cards from texthooker/yomitan, and automatically get screenshot and sentence audio from the
game we are playing.

Short Demo (Watch this first): https://www.youtube.com/watch?v=FeFBL7py6HY

Installation: https://www.youtube.com/watch?v=ybRRB1eIYhk

## How Does it Work?

This is the #1 question I get, and knowing this helps clear up a lot of misunderstanding on issues you may encounter while using GSM.

1. The beginning of the voiceline is marked by a text event. Usually this comes in the form of an event from textractor/agent, or any other texthooking engine. GSM handles both listening for clipboard copy, as well as on a websocket server (configurable in GSM).
2. The end of the voiceline is found using a Voice Activation Detection (VAD) library running on your local machine. ([Example](https://github.com/snakers4/silero-vad))

That's it. 

There are settings in GSM that may help accomodate for a poor hook, but if you encounter wild inconsistencies in your audio, it's likely due to a poorly timed hook, very loud BGM, or some other external factor, not GSM. I have not touched the audio trimming logic for months and it's been excellent for many many people across many games.

## Features:

- **OBS Replay Buffer**: Constantly records the last X seconds of gameplay.
- **Voice Activity Detection**: Automatically cuts the end of the clip to the exact moment the voice ended.
- **Clipboard Interaction**: Automatically monitors the clipboard for dialogue events.
- **Websocket Listening**: Listens to a websocket uri for text-events from stuff like Agent/Textractor.
- **Hotkey Automation**: Single hotkey to trigger video recording, screenshot, and transcription.
- **1-Click Card Creation**: Monitors anki for new cards from Yomitan, and automatically gets audio from games.

## Prerequisites

- [Python 3.11+](https://www.python.org/downloads/release/python-3119/)
- Important: 3.13 is [NOT supported](https://stackoverflow.com/questions/79175945/keyerror-version-installing-openai-whisper-on-python-3-13).

---

## 1. Installing and Running the Script

### New Way as of 2.4.0

Grab the latest Installer from [Releases](https://github.com/bpwhelan/GameSentenceMiner/releases).

### Old Way - Will still work for the forseeable future

https://pypi.org/project/GameSentenceMiner/

Python + pip needs to be installed, make sure you install 3.11 or higher, since older versions may not be supported.

Install:
```commandline
pip install gamesentenceminer
```

Run:
```commandline
gamesentenceminer
```

On first run, this will download OBS and FFMPEG, and do some basic configuration. You will need to edit the GSM config for your specific Anki fields and whatnot.

---

## 2. Setting Up OBS Replay Buffer

1. Go to Settings > Output > Replay Buffer, and make sure OBS Replay Buffer is enabled, I recommend setting it to 60 seconds, but shorter and longer buffers should also work.
2. Set Scene/Source. I recommend using "Game Capture" with "Capture Audio" Enabled. And then mute Desktop/microphone
    1. If "Game Capture" Does not work, use "Window Capture".
    2. I recommend having a Scene PER Game, with the name of the scene labeled as the game, this makes it easier for the
       script to know (with a config option) what game you are playing.
3. In Output Settings, set "Recording Format" to mkv, and "Audio Encoder" to Opus. Alternate Audio Encoder settings are supported, but will be re-encoded to Opus by default.

Here are the Settings I use in OBS. Make sure the recordings folder is the same as the "folder_to_watch" in the config.
![image](https://github.com/user-attachments/assets/0056816d-af3c-4a3c-bc6a-4aff5c28cadb)
![image](https://github.com/user-attachments/assets/dd2f95a6-f546-41d9-8136-de7b1b035a5d)

---

## 3. Configuring the App.

### Configuration GUI

The `GameSentenceMiner` project now includes a graphical interface to simplify configuration. With default values
already set, this GUI lets you adjust settings as needed. Here’s how to get started:

#### Running the Configuration GUI

To open the GUI, you have two options:

1. **Tray Icon**: Right Click the Tray Icon and Click `Open Settings`

#### Default Settings and Customization

The GUI loads with default values for each setting, so if you’re just getting started, you may only need to change options
in the "path" config. If you make changes, remember to click **Save Settings** to apply them.
Please take a second to look through the config to see what is available, there is a lot of extra functionality hidden
behind config options.

![image](https://github.com/user-attachments/assets/ffac9888-de0a-412b-817f-e22a55ce7b55)![image](https://github.com/user-attachments/assets/981c112a-1ddc-4e07-9c39-57fe46644ff5)![image](https://github.com/user-attachments/assets/29470a97-6013-4ca8-9059-48af735eb3a8)![image](https://github.com/user-attachments/assets/8e9c8f03-dc43-4822-a3c5-43f36ca65364)


---


## 4. One Click Card Creation

This is the flagship feature of this script, so here is a section explaining it. It is possible to do full 1-click card
creation with this tool + Yomitan/JL. The relevant settings are located in `Features` and `OBS` section in the config.

Demo: https://www.youtube.com/watch?v=9dmmXO2CGNw

Screenshots to help with setup (THIS IS ALREADY DONE FOR YOU IN NEWER VERSIONS):

![image](https://github.com/user-attachments/assets/7de031e9-ce28-42eb-a8fd-0e60ef70dc3d)

![image](https://github.com/user-attachments/assets/b0c70a1a-65b5-4fe7-a7e4-ccb0b9a5b249)

![image](https://github.com/user-attachments/assets/4cf492eb-12a2-429f-aa0e-f87fc0fa6270)

## 4. Example Process

1. Start script: `gamesentenceminer`
2. Start game
3. Hook Game with Agent (or textractor) with clipboard enabled
4. Create Anki Card with target word (through a texthooker page/Yomitan)
5. When finished gaming, End script (not required)

Once the Anki card is created:

1. **OBS** will save the last X seconds of gameplay.
2. The Python script will trim the audio based on last clipboard event, and the end of voice line detected in VAD if
   enabled.
3. Will attempt to update the LAST anki card created.

---

## How to Update the Script

### PIP Install (Preferred)

If you installed the script via pip, you can update it with the following command:
```bash
pip install --upgrade gamesentenceminer
```


### Source (For if you want to make edits to the script)

I will probably remove this section at a later date. If you want to make edits to the script, you should know how to do this.

To ensure you always have the latest version of this script, you can use `git pull` to update your local repository with
the latest changes from the remote repository.

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
    - **`main`** refers to the main branch of the repository. I~~~~f your default branch has a different name (
      e.g., `master` or `dev`), replace `main` with that branch name.

3. The `git pull` command will download and apply any updates from the remote repository to your local version.

### Example:

```bash
$ cd path/to/script
$ git pull origin master
```

---

## Disclaimer/Troubleshooting

Every game/hook is different, so it's really impossible that any script can get it perfect every time. Also OBS is
sometimes a bit finicky if running for too long. If the audio timing is off, please first try some troubleshooting
steps before making an issue:

- Try Restarting OBS
- Make sure your hook is the best you can find. (Preferably it gives you the text RIGHT when the voice line starts)
- Try Adjusting Offset Configuration in `config.toml` to better match your situation. (i.e. if the hook is late, add a
  negative beginning offset)
- Try using "Trim beginning" in `VAD` settings.

### Setup Troubleshooting

Just going to continuously update this with issues that I have helped users with. Look here first if you have issues
setting it up.

- Make sure folder_to_watch is the same as your recordings path in OBS. It defaults to ~/Videos, but I recommend setting
  it to ~/Videos/GSM.
- If using clipboard, make sure Agent/Textractor sending to clipboard is enabled.
- If using websocket, make sure the websocket server is running and the uri is correct in both GSM AND agent/textractor. Textractor uses a default of 6677, and I would recommend changing Agent to use 6677 as well.


## Contact

If you run into issues ask in my [Discord](https://discord.gg/yP8Qse6bb8), or make an issue here.

## Donations

If you've benefited from this or any of my other projects, please consider supporting my work
via [Github Sponsors](https://github.com/sponsors/bpwhelan) or [Ko-fi.](https://ko-fi.com/beangate)
