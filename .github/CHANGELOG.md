# 09/08/2025 GSM Game Stats

I am pleased to announce that there is now a Stats page in GSM! **Massive** thanks to @autumn12345 for taking this idea much higher than I imagined it would go.

## How to Access

You can access the new stats page by default at localhost:55000/stats or on whatever port you have the texthooker page configured to use.

## How is there already data in there?

GSM a month ago or so started to keep a database of lines received from games (completely local, GSM does NOT touch the internet except for downloading tools/whisper, as well as AI prompts), and now you can see all that data visualized!

I did have the crazy idea of a "download gamescript" button that would roll up all the lines and spit it out to a csv/txt/etc. that may be added somewhere in here in the future.

## What all is available?

I'm not going to go much into detail since it would be much easier for you to see for yourself, but just a short list:

- Metrics on how many characters per game you've read, how fast you read, streaks, encountered kanji, etc.
- Search tab to search through all the lines from the various games you've played with GSM open.
- Database management tab to clear up games that you've dropped, duplicate lines, extra long lines, etc.

## Is this data being sent anywhere else?

Absolutely not. Never.
<img width="1139" height="694" alt="msedge_E9LkFpmrcI" src="https://github.com/user-attachments/assets/e34a0fc4-0dc8-4cb8-a45b-da2f7af127fd" />
<img width="1115" height="1113" alt="msedge_ezr3kiahZ5" src="https://github.com/user-attachments/assets/0ea41add-33c0-4124-bcb2-867488630f23" />
<img width="1207" height="934" alt="msedge_9VFd9KL2dO" src="https://github.com/user-attachments/assets/bb4d8f4d-7b19-40ed-ab7a-4da7a09ffbff" />
<img width="1198" height="889" alt="msedge_9ecjqG9EMJ" src="https://github.com/user-attachments/assets/673a490e-3bd2-40d3-89ac-3ce69726942b" />
<img width="1114" height="1088" alt="msedge_RcXZAHqVKE" src="https://github.com/user-attachments/assets/75488aa0-3c5f-4759-b86e-9f078f46d5ae" />

# 1.12.0 / 2.15.0

Some Very nice improvements to OCR, and the Overlay

# OCR

## Ignore Auto-OCR Result if ALL Text is in a "menu" area.

In https://discord.com/channels/1286409772383342664/1286409772383342667/1401432690288496721, there was a 3rd OCR area introduced that allows you to OCR any menu text on command. These areas now serve a second purpose.

If ALL Text found in the normal AutoOCR is located in a menu box, that result will be ignored. See photos for details. In the first one, it will not be ignored because there is text in the green area. In the second one, no text would come back, because the only thing that's in the green area is タイトル and that's also in a purple box. This should allow you to set areas in the menu that can be ignored when you pause your game, but not completely cut those areas off from Auto OCR. In the future this may be another "type" of area, but for simplicity, this is how it is for now.

<img width="1280" height="720" alt="python_u4DlHs62tp" src="https://github.com/user-attachments/assets/2aa021cc-af3d-4b68-95b3-d3bb8f3074ef" />
<img width="1280" height="720" alt="python_j0ha3m3GFT" src="https://github.com/user-attachments/assets/26aa7e22-f950-443f-aea7-a2f48ea1acf9" />

## Furigana Filter PER Game

Furigana Filter should now be tied to the game, rather than a global config. The way I did this is pretty tricky, so I'm not entirely confident it will work 100%.

## Do OCR Replacements first

[Github Issue](<https://github.com/bpwhelan/GameSentenceMiner/issues/136>)

This will simply just do the OCR replacements if you have them (they are kind of hidden in debug, since OCR is pretty good without them) FIRST, before anything else. If you find that some characters mess with stability, you may be able to add replacements, but they should be used sparingly.

# Overlay

## Use Raw Percentages instead of coordinates

This should simply make Overlay viable if you have Windows Scaling enabled.

## Force some useful yomitan features

I can kind of force some settings in yomitan regardless of what you have configured, I will probably do more as time goes by just to make a better overlay experience. Here are a few from this round.

- No scan modifier (Only hover to lookup)
- Auto-Hide popup, This will eliminate the need to double click, once to hide popup, and once to advance dialogue.
- TextLayout Awareness turned OFF, the overlay is a very weird layout in terms of HTML, so this is better OFF.

## Less Aggressive Magpie Compat

Turns out I can make the overadjusted area a bit smaller, so I've done so, should interfere less with UI buttons now.

## Open Yomitan Settings Hotkey

- Hardcoded to Alt+Shift+Y

# 1.11.5 / 2.14.20

- Re-wrote Furigana Filter Preview, should now make a lot more sense, and makes it a lot easier to find the value that you want.
- Cleaned up some UI surrounding the OCR engines to use, no longer is it "OCR 1" and "OCR 2"
- Changed Furigana Filter to filter per line dimensions rather than per character dimensions. This should result in a lot more consistent results and less randomness.
![ee441500-06de-4c12-9981-6118a2ad8090](https://github.com/user-attachments/assets/45a7b45c-e909-45d7-9db6-6b87a4c85e58)
![yuzu_Yhuu0zlnhF](https://github.com/user-attachments/assets/1030e84e-cff0-468a-bc9c-9e3399060208)

# 1.10.4 -> 1.11.4

- Moved over to using uv for pip package management
- Added Animated Screenshot, and video options
- More overlay fixes
- UI cleanup

# 1.10.4 / 2.14.5

## OCR

- Force "use obs for ocr" setting ON. You can turn it off in the debug section, but I am considering it UNSUPPORTED at this time.
- Will now check for stability in the image instead of exact sameness, this should help with really tiny changes in the image forcing another OCR to happen.
- Fixed LLM OCR attempting to initialize when it's not setup or configured.
- There is now a gradual rest to OCR if it keeps getting the same exact text over and over again, or notices that the image hasn't changed. This starts to kick in after 10 seconds, and will increase the sleep time .005 with each scan. The max this can go is .5 seconds, so if your ocr scan rate is .5 or higher, this does NOT affect you.

## Overlay

- Now will let you click out of the overlay more reliably.

## GSM

- Added some more Key settings, including OcenAudio, and Audio Splicing.
- Will now check the replay buffer every 5 seconds and attempt to warn you about it if there is image being captured, but replay buffer is not on.

## Texthooker

- Added a little convenience option on the very bottom left, you can enter a number there, hit `Enter` and it will send the last X amount of lines to be translated, and then it will be printed out in the texthooker page. This is quick and dirty, but should rarely be used.

# 1.10.0 / 2.14.0

A ton of changes here, I tested to the best of my ability, so hopefully it should all be good.

## Overlay 

I still consider the overlay WIP, but it is now packaged in with GSM and can be run in GSM in the "Home" Tab. In case you haven't seen, the Overlay is Yomininja-like overlay that will provide on-screen lookups when you hover the text in game.

I will be writing up some docs and recording some videos around this, but to get started, it's just `Open Overlay (WIP)` in the `Home` Tab -> Setup Yomitan in the Overlay -> Get On-screen lookups.

There are two hotkeys in the overlay that may be useful, but are hard-coded for the moment.
- **Alt+Shift+H**: This Hides the "main box" in the overlay, allowing you to just use the on-screen lookups.
- **Alt+Shift+J**: This attempts to minimize the overlay, in case it's causing issues with being able to click in game and whatnot, it will however be maximized on the next line of text that comes into GSM.

<img width="1266" height="993" alt="image" src="https://github.com/user-attachments/assets/559055b0-ce6c-4fd5-af91-06571e193751" />

<img width="2560" height="1440" alt="image" src="https://github.com/user-attachments/assets/23d89a42-ab14-4092-a824-68ef0d84fc45" />


## OpenAI-Compatible AI Prompting

With this, you should be able to use almost any provider for Ai, including locally run OpenAI-Compatible APIs (LM-Studio Recommended).

<img width="852" height="756" alt="image" src="https://github.com/user-attachments/assets/ad9f6190-ae41-4a34-bae7-3fba959b8051" />

### Automatically get Models from Gemini and Groq

GSM will now attempt to pull all available models from Gemini and Groq instead of hard-coding. Some Recommended models are still hard-coded.

<img width="852" height="756" alt="image" src="https://github.com/user-attachments/assets/8b47fe5b-63af-4a68-8a09-a8b9a474fb64" />

## Simplified OCR Setup

OCR using OBS as source is now the DEFAULT, and is now opt-out instead of opt-in. You can find the opt-out feature in the `Extra & Debug Tools` Section, but I do not recommend it, and am unlikely to make as many improvements to.

<img width="1266" height="993" alt="image" src="https://github.com/user-attachments/assets/cfc9755d-7e7e-450e-afa7-76638a9fd934" />


LOTS OF CHANGES FROM THE PREVIOUS LOG, TOO MUCH TO UPDATE HERE.

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
