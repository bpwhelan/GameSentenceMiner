## 2.5.0

### New

- Config option to open Multi-line window when GSM starts (Default: **OFF**)
- Config Option to add Audio even when no voice is found by VAD (Default: **OFF**)
- Option for beginning offset for the VAD result (aka start of voice + beginning offset, negative = more time before voice starts), Only Active if `Vad Trim Beginning` is ON (Default: **-0.25**)
- Button for Install ocenaudio + Select Anki Default Media Directory for "Open in External Program" Workflow (In `Audio` Tab)

- Try to Verify Anki Fields and find alternatives, if no alternatives found, print useful error instead of the stacktrace
- Added notification when it errors to check the console/debug for more info.

### Changed

- Backend Anki Card Object changes, shouldn't change any logic, just makes the Anki card easier to work with in Python
- Removed "Get all future audio when mining from history" option, redundant, confusing
- Updated the `remove_html_tags` logic when finding the sentence in history to also remove cloze tags, this will not reflect in your anki card, it will just make finding the sentence you are actually mining more reliable
- Made some errors give more information than just printing the stacktrace (i.e. when there are no lines recieved)

### Fixed

- Preserve HTML/Cloze Tags in Anki when multi-mining and replacing Sentence is **enabled.**
- Beginning VAD Trimming being weird, sometimes it would just add arbitrary space, or remove space at random

## 2.4.0 - 2.5.0

Mostly small things, the biggest things were

- Auto Updater
- Start GSM Minimized
- Option to keep clipboard and websocket both open
- Maybe some other small fixes

## 2.4.0 - [Electron App](https://discord.com/channels/1286409772383342664/1344865618498945144)!

This is currently very simple app that allows me to install Python and GSM for new and existing users.

## What is Changing

No update to the actual audio trimming/python logic, but with this update comes the new way I want to distribute GSM, and how you should run GSM. the old way will work for the forseeable future, but there will now be an executable package/installer that you can run instead of ever touching the terminal. (uses the same system as familiar tools like discord, kamui, etc.)

### Install: Old -> New

- Install Python and pip install gamesentenceminer -> Run Installer and/or GameSentenceMiner.exe and it installs python/gsm for you

You can find them here https://github.com/bpwhelan/GameSentenceMiner/releases/tag/2.4.0. The screenshots I've attached are after I've run the Installer.

## Future Plans

I have a few more improvements already planned that moving to an electron app makes possible.

- Auto Updater / 1 click Update - This is first, I dont want people to have to go into the appdata dir and update from there.
- Integrate More tools into gsm like my yuzu launcher/steam launcher

## Limitations/Issues

Currently only on Windows so far since im building from my personal machine, but Linux support should be very easy when i get around to it.

Nothing else that I know of yet, the only thing to note is that this installs a portable version of python in `%APPDATA%/GameSentenceMiner/python` with all the dependencies there too. If you want to clean up the previous global install you can run `pip uninstall gamesentenceminer` or if you want to cleanup dependencies as well: 

```
pip install pip3-autoremove
pip-autoremove gamesentenceminer
```

This also means that if you need to override dependencies you need to do them in the new python directory. for example, the CUDA version of torch if you use whisper and want to use your GPU (this might not be your exact command)... `C:/Users/Beangate/Appdata/Roaming/GameSentenceMiner/python/python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126`

---

### 1.10.0 to Today

- pip install
- previous sentence
- previous sentence screenshot
- multi-line mining
- open audio in external program
- screenshot timing setting

---

### 1.10.0

Lots of changes with this one.

- Added Profiles to Settings: Can now change every setting based on profile, and switch between them
- Filename sanitization : Special Characters in OBS Scene no longer breaks filenames
- Fix/Update the way we get Screenshots while mining from previous Lines. Simply a few seconds after the line that you mine (time configurable in Screenshots tab of Settings)
- Launchers moved into their own folder, soon there will be a massive overhaul on how the project is structured and this is the start.
- Steam Launcher re-designed to allow you to configure your own games in steam_games.py

#### Profiles

![image](https://github.com/user-attachments/assets/5e66eece-ac9e-40b1-be46-12b10d5263fe)
![image](https://github.com/user-attachments/assets/754b29d4-fff7-4e4e-86fd-f7a72edb3cfd)
![image](https://github.com/user-attachments/assets/0fcb3639-37be-4523-a1f4-5dc7343d7a45)


#### Screenshot Timing Setting

![image](https://github.com/user-attachments/assets/867df8fa-70f0-4149-afc0-491a2aa399ba)


#### Steam Launcher Configuration

`launchers/steam_games.py`

```
manual_config = [
    SteamGame(948740, "AI: The Somnium Files", "AI_TheSomniumFiles.exe", r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts\PC_Steam_Unity_AI_The_Somnium_Files.js"),
    SteamGame(834530, "Yakuza Kiwami", "YakuzaKiwami.exe", r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts\PC_Steam_Yakuza.Kiwami.js")
    # SteamGame(638970, "Yakuza 0", "Yakuza0.exe", r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts\PC_Steam_Yakuza.0.js")
]
```

### 1.9.2

Another tiny update, added a config for whether or not the screenshot hotkey should update the last created anki card. This does not affect the general workflow, only screenshot hotkey. The config is located in the Screenshot tab.

False/Unchecked -> Screenshot hotkey will only take the screenshot, re-encode it (if configured) and place it in the Screenshots folder.
True -> Screenshot hotkey will take the screenshot, re-encode it and then shove it in the last created anki card.

I don't think many people use this feature, but all it does is grab the current frame from obs. 

### 1.9.1

Very small update, just something that I wanted personally that I could see other people using. The commit is like 10 lines of code, no actual logic is changed.

Reasoning: If you don't want to shut down the script, but you also don't want to allow OBS to just continue recording nothing and taking up resources.

https://github.com/bpwhelan/GameSentenceMiner/releases/tag/1.9.1

Changed
Added another menu item to the tray to Pause/Resume the OBS Replay Buffer.

### 1.9.0

Finally added something I wanted to add a while ago, was a bit simpler than i expected.
Ability to open the Anki Audio in an external tool (I highly recommend [ocenaudio](https://www.ocenaudio.com/)) to trim the audio after flash card creation. If you use ocenaudio, and have the path set to anki, you can edit the audio **in place** and the audio in the anki card will automatically be updated. 

I will likely record a video so this becomes more clear, but in the meantime hopefully these screenshots explain it better.

The screenshots are Original Audio -> Select Portion -> Trim (Alt + T) -> Save (Ctrl + S). And now the audio is perfectly trimmed in my anki card. I also included both original and trimmed audio.

![image](https://github.com/user-attachments/assets/1ccbc0cb-ee82-4215-8bcb-9fab35e864d7)
![image](https://github.com/user-attachments/assets/9244c22e-0ef8-4ef9-a0a3-c1136db8b975)
![image](https://github.com/user-attachments/assets/307ec1ae-9ba1-40c5-b135-b1cd901900d4)
