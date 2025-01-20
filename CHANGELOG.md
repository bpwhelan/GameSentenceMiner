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
