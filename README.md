# Game Sentence Miner

This project automates the recording of game sentence audio to help with Anki Card Creation.

This allows us to create cards from texthooker/yomitan, and automatically get screenshot and sentence audio from the
game we are playing.

Short Demo (Watch this first): https://www.youtube.com/watch?v=FeFBL7py6HY

Installation: https://youtu.be/h5ksXallc-o

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

---

## Documentation

Help with Installation, Setup, and other information can be found in the project's [Wiki](https://github.com/bpwhelan/GameSentenceMiner/wiki).

## Example Process

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

## Disclaimer/Troubleshooting

Every game/hook is different, so it's really impossible that any script can get it perfect every time. Also OBS is
sometimes a bit finicky if running for too long. If the audio timing is off, please first try some troubleshooting
steps before making an issue:

- Try Restarting OBS
- Make sure your hook is the best you can find. (Preferably it gives you the text RIGHT when the voice line starts)
- Try Adjusting Offset Configuration in the config to better match your situation. (i.e. if the hook is late, add a
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
