# OwOCR

Command line client for several Japanese OCR providers derived from [Manga OCR](https://github.com/kha-white/manga-ocr).

# Installation

This has been tested with Python 3.11, 3.12 and 3.13. It can be installed with `pip install owocr`.

# Usage

Basic usage is comparable to Manga OCR as in, `owocr` keeps scanning for images and performing text recognition on them. Similarly, by default it will read images from the clipboard and write text back to the clipboard (or optionally, read images from a folder and/or write text to a .txt file if you specify `-r=<folder path>` or `-w=<txt file path>`).

Additionally:
- Scanning the clipboard takes basically zero system resources on macOS and Windows
- Supports reading images and/or writing text to a websocket with the `-r=websocket` and/or `-w=websocket` parameters (the port is 7331 by default, and is configurable in the config file)
- On macOS and Linux, supports reading images from a Unix domain socket (`/tmp/owocr.sock`) with `-r=unixsocket`
- On Windows and macOS, supports capturing from the screen directly or from a specific window with `-r=screencapture`. By default it will open a coordinate picker so you can select an area of the screen and then read from it every 3 seconds, but you can change it to screenshot the whole screen, a manual set of coordinates `x,y,width,height` or just a specific window (with the window title). You can also change the delay between screenshots or specify a keyboard combo if you don't want screenshots to be taken periodically. Refer to the config file or to `owocr --help` for more details about the screen capture settings
- You can read images from another source at the same time with `-rs=`, the arguments are the same as `-r`
- You can pause/unpause the image processing by pressing "p" or terminate the script with "t" or "q" inside the terminal window
- You can switch between OCR providers pressing their corresponding keyboard key inside the terminal window (refer to the list of keys in the providers list below)
- You can start the script paused with the `-p` option or with a specific provider with the `-e` option (refer to `owocr -h` for the list)
- You can specify keyboard combos in the config file to pause/unpause and switch the OCR provider from anywhere (refer to the config file or `owocr -h`)
- You can auto pause the script after a successful text recognition with the `-a=seconds` option if you're not using screen capture with automatic screenshots. 0 (the default) disables it.
- You can enable notifications in the config file or with `-n` to show the text with a native OS notification if you're not using screen capture with automatic screenshots. **Important for macOS users:** if you use Python from brew, you need to enter this command in your terminal before the first notification: `codesign -f -s - $(brew --cellar python)/3.*/Frameworks/Python.framework` (works on Ventura/Sonoma). Older macOS versions might require Python to be installed from the [official website](https://www.python.org/downloads/). Nothing can be done about this unfortunately.
- Optionally, you can speed up the online providers by installing fpng-py: `pip install owocr[faster-png]` (requires setting up a developer environment on most operating systems/Python versions)
- Optionally, you can improve filtering of non-Japanese text for screen capture by installing transformers and sentencepiece: `pip install owocr[accurate-filtering]`
- A config file (which will be automatically created in `user directory/.config/owocr_config.ini`, on Windows `user directory` is the `C:\Users\yourusername` folder) can be used to configure the script, as an example to limit providers (to reduce clutter/memory usage) as well as specifying provider settings such as api keys etc. A sample config file is also provided [here](https://raw.githubusercontent.com/AuroraWright/owocr/master/owocr_config.ini)
- For systems where text can be copied to the clipboard at the same time as images, if `*ocr_ignore*` is copied with an image, the image will be ignored (mostly useful for devs making their own sender tool)

# Supported providers

## Local providers
- [Manga OCR](https://github.com/kha-white/manga-ocr): install with `pip install owocr[mangaocr]` ("m" key)
- [EasyOCR](https://github.com/JaidedAI/EasyOCR): install with `pip install owocr[easyocr]` ("e" key)
- [RapidOCR](https://github.com/RapidAI/RapidOCR): install with `pip install owocr[rapidocr]` ("r" key)
- Apple Vision framework: this will work on macOS Ventura or later. In my experience, the best of the local providers for horizontal text ("a" key)
- Apple Live Text (VisionKit framework): this will work on macOS Ventura or later. It should be the same as Vision except that in Sonoma Apple added vertical text reading ("d" key)
- WinRT OCR: install with `pip install owocr[winocr]` on Windows 10 and later. It can also be used by installing winocr on a Windows virtual machine and running the server there (`winocr_serve`) and specifying the IP address of the Windows VM/machine in the config file ("w" key)
- OneOCR: install with `pip install owocr[oneocr]` on Windows 10 and later. In my experience it's pretty good, though not as much as the Apple one. You need to copy 3 system files from Windows 11 to use it, refer to the readme [here](https://github.com/AuroraWright/oneocr). It can also be used by installing oneocr on a Windows virtual machine and running the server there (`oneocr_serve`) and specifying the IP address of the Windows VM/machine in the config file ("z" key)

## Cloud providers
- Google Lens: Google Vision in disguise (no need for API keys!), install with `pip install owocr[lens]` ("l" key)
- Google Lens (web): alternative version of Lens (Google webpage version). Results should be the same but it's much slower. Install with `pip install owocr[lensweb]` ("k" key)
- Bing: Azure in disguise (no need for API keys!) ("b" key)
- Google Vision: install with `pip install owocr[gvision]`, you also need a service account .json file named google_vision.json in `user directory/.config/` ("g" key)
- Azure Image Analysis: install with `pip install owocr[azure]`, you also need to specify an api key and an endpoint in the config file ("v" key)
- OCRSpace: you need to specify an api key in the config file ("o" key)

# Acknowledgments

This uses code from/references these projects:
- Viola for working on the Google Lens implementation (twice!) and helping with the pyobjc VisionKit code!
- [google-lens-ocr](https://github.com/dimdenGD/chrome-lens-ocr) for additional Lens reverse engineering and the headers/URL parameters I currently use
- @ronaldoussoren for helping with the pyobjc VisionKit code
- @bropines for the Bing code ([Github issue](https://github.com/AuroraWright/owocr/issues/10))
- [Manga OCR](https://github.com/kha-white/manga-ocr)
- [ocrmac](https://github.com/straussmaximilian/ocrmac) for the Apple Vision framework API
- [NadeOCR](https://github.com/Natsume-197/NadeOCR) for the Google Vision API
- [ccylin2000_lipboard_monitor](https://github.com/vaimalaviya1233/ccylin2000_lipboard_monitor) for the Windows clipboard polling code
