# Sentence Mining Game Audio Trim Helper

This project automates the recording of game sentence audio to help with Anki Card Creation. You can trigger the entire process with a single hotkey that captures both video and a screenshot while sending the video for speech-to-text processing.


This README is largely AI Generated, if you run into issues find me on discord @Beangate, or make an issue. I've used this process to generate ~100 cards from Dragon Quest XI so far and it's worked quite well.


## Features:
- **Azure Speech Recognition**: Automatically cuts the end of the clip to the exact moment the voice ended.
- **OBS Replay Buffer**: Constantly records the last 30 seconds of gameplay.
- **ShareX**: Takes screenshots of the game at the moment of the replay.
- **Clipboard Interaction**: Automatically monitors the clipboard for dialogue events.
- **Hotkey Automation**: Single hotkey to trigger video recording, screenshot, and transcription.

## Prerequisites

- [Python 3.7+](https://www.python.org/downloads/)
- [OBS Studio](https://obsproject.com/)
- [ShareX](https://getsharex.com/)
- [Azure Account](https://azure.microsoft.com/) for Speech Recognition
- [Azure Speech SDK for Python](https://pypi.org/project/azure-cognitiveservices-speech/)

---

## 1. Setting Up Azure Speech Recognition (Optional)

If apikey is not present, it will skip voice recognition and audio will be left over at the end. This may change at a later date if i figure out local voice recognition/audio patterns.

### Step 1: Sign Up for Azure
- Visit [Azure's Free Tier](https://azure.microsoft.com/en-us/free/) and create an account.
- Once registered, navigate to the **Azure Portal**.

### Step 2: Create a Speech Service Resource
1. In the Azure Portal, click **Create a resource**.
2. Search for **Speech** and select **Speech** from the list.
3. Choose **Create** and provide the necessary information, including the **Region**, **Name**, and **Pricing Tier** (Free tier is available).
4. Once created, navigate to the **Keys and Endpoint** section of the speech resource to get your **API Key** and **Endpoint URL**.

### Step 3: Get Your Subscription Key and Endpoint
- From the Azure Speech resource dashboard, locate the **Subscription Key** and **Region (Endpoint URL)**. You’ll need these for the Python code.

---

## 2. Setting Up OBS 30-Second Replay Buffer

1. **Install OBS Studio**: Download and install OBS from [here](https://obsproject.com/).
2. **Enable Replay Buffer**:
   1. Open OBS and navigate to **Settings → Output → Replay Buffer**.
   2. Enable the **Replay Buffer** and set the duration to **30 seconds**, this can be lower, but the extra buffer doesn't hurt.
3. **Set a Hotkey for the Replay Buffer**:
   1. Go to **Settings → Hotkeys** and find **Save Replay Buffer**.
   2. Assign a hotkey for saving the replay.
4. **Set up obs websocket** (Super Optional)
    1. Can allow my script to automatically start (and stop) the replay buffer.

---

## 3. Setting Up ShareX to Screenshot the Game

1. **Download ShareX**: Get ShareX from [here](https://getsharex.com/).
2. **Configure Screenshot Hotkey**:
   1. Open ShareX and go to **Hotkey Settings**.
   2. Click **Add** and choose **Capture Active Window** (or any region/mode you prefer).
      1. I actually use "pre-configured window" atm, will take a screenshot of the game no matter where you are (like if you are on webhook page)
   3. Set a hotkey (The same as Replay Buffer works flawlessly for me) for taking screenshots of the game.
   4. Optionally, configure **After Capture Tasks** (e.g., copy to clipboard, save to a folder).

---

## 6. Configuring `config.py`

Your `config.py` file allows you to configure key settings for the automation process, such as your Azure credentials, file paths, and other behavior. Here are the configurable options:

```python
subscription_key = ""  # Your Azure Speech API Key
region = ""  # Your Azure Region

folder_to_watch = ""  # Adjust to your OBS output directory
audio_destination = "/"  # Directory where processed audio files are saved
sharex_ss_destination = ""  # Directory where ShareX saves screenshots

current_game = "Dragon Quest XI"  # Set your current game (optional)

# Anki Fields
sentence_audio_field = "SentenceAudio"
picture_field = "Picture"
source_field = "Source"

# Behavior flags
remove_video = True  # Whether to remove the original video file after processing
remove_untrimmed_audio = True  # Whether to remove untrimmed audio after trimming
update_anki = True  # Whether to update Anki with the audio and screenshot
```

Make sure to adjust the paths and API keys to suit your setup.

---

## 7. Automating the Process

1. Start/hook game/agent/script.
2. Create Anki Card with target word (through a texthooker page)
3. Trigger Hotkey

Once the hotkey is triggered:
1. **OBS** will save the last 30 seconds of gameplay.
2. **ShareX** will take a screenshot of the current game window.
3. The Python script will trim the audio based on last clipboard event, as well as Azure Transcription if enabled.
4. Will attempt to update the LAST anki card created.

---

## Conclusion

This setup allows you to record key moments in your game automatically, capture screenshots, and transcribe dialogue, all through a simple hotkey. Enjoy automating your gaming content creation!
