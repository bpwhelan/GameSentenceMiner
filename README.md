# GameSentenceMiner (GSM)

An application designed to assist with language learning through games. Aiming to be the "asbplayer" for games.

Short Demo (Watch this first): https://www.youtube.com/watch?v=FeFBL7py6HY

Installation: https://youtu.be/h5ksXallc-o

## Features

### Anki Card Enhancement

GSM can significantly enhances your Anki cards with rich contextual information:

* **Automated Audio Capture**: Automatically records the voice line associated with the text.

* **Screenshot Integration**: Captures a screenshot of the game at the moment the voice line is spoken.

* **Contextual Awareness**: Preserves the surrounding game context to provide valuable learning cues. 

* **AI Translation**: Integrates AI translation to provide quick translations of the captured sentence. (Optional, Bring your own Key)


#### Game Example
![anki_RozcrisS8B](https://github.com/user-attachments/assets/b1f08150-6b46-4d7d-ad90-e6c468076b05)

![Audio](https://github.com/user-attachments/assets/94360986-8dbf-42c9-b3c3-d054893eac3d)

---

#### VN Example
![anki_Lk3Ds2T1Bz](https://github.com/user-attachments/assets/e8ae4d66-f138-4ae1-9df7-46e16249be41)

![Audio](https://github.com/user-attachments/assets/2d7b3967-cd5c-4132-b489-75058ea20921)


### OCR

GSM integrates with [OwOCR](https://github.com/AuroraWright/owocr/) to provide accurate text capture from games that do not have a hook. Here are some improvements GSM makes on stock OwOCR.

* **Easier Setup**: With GSM's managed python install, set up is only a matter of clicking a few buttons in GSM

* **Exclusion Zones**: Intead of chosing an area to OCR, you can also choose an area to exclude from OCR. Useful for if you have a static interface in your game and text appears randomly throughout.

* **Two-Pass OCR**: To cut down on API Calls, and keep output clean, GSM features a "Two-pass" OCR System. A Local OCR will be constantly running, and when the text on screen stabilizes, it will run a second, more accurate scan that gets sent to clipboard/websocket.

* **Consistent Audio Timing**: With the two-pass system, we can still get accurate audio recorded and into anki without the use of crazy offsets or hacks.

* **More Language Support**: Stock OwOCR is hard-coded to japanese, in GSM you can use a variety of langauges.


![GameSentenceMiner_efBTEpbZ2A](https://github.com/user-attachments/assets/4b873f9e-c049-428c-9bfd-20907e095054)
![anki_f3PdqYLN2n](https://github.com/user-attachments/assets/a901221c-6f7c-471b-a1f3-f29e8ced102c)

![Audio](https://github.com/user-attachments/assets/8c44780a-9b74-41af-bf16-28a742f4de12)


### Game Launcher Capabilities (WIP)

This is probably the feature I care least about, but if you are lazy like me, you may find this helpful.

* **Launch**:  GSM can launch your games directly, simplifying the setup process.

* **Hook**:  Streamlines the process of hooking your games (Agent).

This feature simplifies the process of launching games and hooking them with translation agents, making the entire workflow more efficient.

![image](https://github.com/user-attachments/assets/eb630535-d291-4386-a5af-9f54b718896a)

## Basic Requirements

* **Anki Card Creation Tool** - Such as [Yomitan](https://github.com/yomidevs/yomitan), [JL](https://github.com/rampaa/JL), etc.

* **A method of getting text from the game**: [Agent](https://github.com/0xDC00/agent), [Textractor](https://github.com/Artikash/Textractor), [LunaTranslator](https://github.com/HIllya51/LunaTranslator), GSM's OCR, etc.

* **A game :)**

## Documentation

For help with installation, setup, and other information, please visit the project's [Wiki](https://github.com/bpwhelan/GameSentenceMiner/wiki).

## FAQ

### How Does It Work?

This is a common question, and understanding this process will help clarify any issues you might encounter while using GSM.

1.  The beginning of the voice line is marked by a text event. This usually comes from a textractor/agent event or another text-hooking engine. GSM can listen for clipboard copy and on a websocket server (configurable in GSM).

2.  The end of the voice line is detected using a Voice Activity Detection (VAD) library running locally. ([Example](https://github.com/snakers4/silero-vad))

In essence, GSM relies on accurately timed text events to capture the corresponding audio.

GSM provides settings to accommodate less-than-ideal hooks. However, if you experience significant audio inconsistencies, the problem likely stems from a poorly timed hook, loud background music, or other external factors, rather than GSM itself. The core audio trimming logic has been stable and effective for many users across various games.

## Contact

If you encounter issues, please ask for help in my [Discord](https://discord.gg/yP8Qse6bb8) or create an issue here.

## Acknowledgements

* [OwOCR](https://github.com/AuroraWright/owocr) for their outstanding OCR implementation, which I've integrated into GSM.

* [chaiNNer](https://github.com/chaiNNer-org/chaiNNer) for the idea of installing Python within an Electron app.

* [OBS](https://obsproject.com/) and [FFMPEG](https://ffmpeg.org/), without which GSM would not be possible.

## Donations

If you've found this or any of my other projects helpful, please consider supporting my work through [GitHub Sponsors](https://github.com/sponsors/bpwhelan) or [Ko-fi](https://ko-fi.com/beangate).
