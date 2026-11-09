# Launching games from Home (Windows)

Select a game in Home and click **Launch game**. GSM launches the game and its
existing automatic game detection handles capture, OCR, text hooking, and the
overlay according to your settings.

GSM remembers the full executable path when it can match the game's OBS capture
to a running Windows window. OBS itself supplies the executable name, rather
than its full path. Discovery also runs while other tabs are open. If the game
has not been seen yet, the path is inaccessible, or multiple installations match,
open **Launch options** and use **Browse**. **Detect from running game** retries
discovery without replacing your saved options until you save them.

Launch options are stored by OBS scene UUID, so renaming a game keeps its launch
settings. They include the game executable, game arguments, working folder, and an
optional custom launcher. The working folder defaults to the game executable's
folder. Clicking Launch with unsaved edits saves them first; a failed save stops
the launch.

## External launchers

Choose the launcher's executable under **Custom launcher**. Its arguments are a
template: `{game}` inserts the game path; a separate `{args}` argument expands to
the game's arguments. Quote paths and argument values using Windows double-quote
conventions. Arguments are passed directly to the executable; shell commands and
environment variables are not expanded.

| Launcher | Launcher arguments |
| --- | --- |
| Special K / SKIF | `"{game}" {args}` (the default) |
| Locale Emulator / LEProc, default or existing game profile | `"{game}" {args}` |
| LEProc, explicitly use/configure a game profile | `-run "{game}" {args}` |
| LEProc, a specific global profile | `-runas "PROFILE-GUID" "{game}" {args}` |

The launcher must already be installed. GSM does not bundle locale emulation or
manage locale profiles. A successful request means Windows started the game or
launcher; a launcher may still display its own error or configuration window.
Games run independently and are not stopped when GSM closes.

References: [SKIF command-line options](https://github.com/SpecialKO/SKIF#command-line-arguments),
[LEProc command-line implementation](https://github.com/xupefei/Locale-Emulator/blob/master/LEProc/Program.cs).
[LunaTranslator's quick-launch flow](https://docs.lunatranslator.org/en/basicuse.html#quick-launch-and-hook)
provided light inspiration; GSM continues to use its existing automatic detection
after the game starts.
