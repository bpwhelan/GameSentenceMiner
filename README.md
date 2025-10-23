# Texthooker UI

A web interface for using websocket-based interfaces, such as:
- [Textractor](https://github.com/Artikash/Textractor) with [textractor-websocket](https://github.com/kuroahna/textractor_websocket) or [TextractorSender](https://github.com/KamWithK/TextractorSender)
- [mpv](https://mpv.io) with [mpv_websocket](https://github.com/kuroahna/mpv_websocket)

An online version of the page can be accessed [here](https://renji-xd.github.io/texthooker-ui/).

An offline version of the page can be downloaded from the [docs](https://github.com/Renji-XD/texthooker-ui/tree/main/docs) folder (make sure to also download the assets folder and content in case you want to use some of the custom online fonts) or build locally by your own.

**Note:** If you are interested in persistent statistics, history and additional mining capabitilies / workflows you may want to checkout [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner) which runs a forked version of this web interface.

## Building

```
# Install pnpm
npm install --global pnpm

# Install dependencies
pnpm install

# Build the Page
pnpm run build

# Optional - serve the Page via local Server
pnpm run preview
```

The page can be opened via the index.html inside the "docs" folder and is usable without the need of hosting it via a server.

## FAQ

### I can't connect to the websocket with textractor-websocket.

-   [Sadolit's textractor-websocket](https://github.com/sadolit/textractor-websocket) requires that textractor captures at least one line before starting the server - connect manually afterwards. Alternatively try [kuroahna's textractor_websocket](https://github.com/kuroahna/textractor_websocket) which does not have this issue.

### I can't connect to the websocket with TextractorSender.

-   Make sure you are using the right port which is 9001

### I can't connect to the websocket with a different plugin/still can't connect to the websocket with one of the mentioned plugins.

-   Make sure your firewall is not blocking the required ports. You can also check if another extension is interfering by trying out the page with a clean temporary profile and disabled extensions
-	**For Brave Users**: If you are using a hosted / online version of the page disable the brave shield for the domain to allow the usage of unsafe websocket connections. Alternatively try out the local / offline version which you can find in the [docs](https://raw.githubusercontent.com/Renji-XD/texthooker-ui/main/docs/index.html) folder

### Can I use this page with extensions like [Clipboard Inserter](https://github.com/kmltml/clipboard-inserter) or [lap-clipboard-inserter](https://github.com/laplus-sadness/lap-clipboard-inserter)?

-   When "Enable external Clipboard Monitor" is checked text appended as paragraph to the page body will be taken over by the app. Make sure to enable this setting before the actual extension to avoid wrongly pasted elements

### How do I customize the page with CSS?

-   You can use normal CSS syntax and rules via the "Custom CSS" Field. The content will be appended as style node to the page header

### How can I delete lines?

There are multiple ways of deleting a line:

-   Click on the "Delete last Line" Icon in the header
-   Click on the "Reset Lines" / "Reset Data" / "Reset All" Icon in the settings menu
-   Highlight a line and press the "Delete" key on the keyboard
-   Have no text highlighted and press the "Alt" + "Delete" key on the keyboard
-   Select a Line for deletion by holding the "CTRL" key (or "command" key on macOS) on the keyboard and double click on it (you can press "Escape" to unselect lines again). Afterwards click on the "Remove selected Lines" icon in the header

### How can I edit a line?

-   You can modify the content of a line by double clicking on it. Clicking somewhere outside will exit the edit mode. Changes to the text will automatically be reflected in the character counter

### What is covered by "Undo last Action"?

_Note_: By default, the undo history is stored in memory only. If you want to keep it across tab reloads, make sure to enable the respective setting.

-   Deleting lines by clicking on the "Remove last line" icon
-   Deleting lines by highlighting them and pressing the "Delete" key on the keyboard
-   Deleting last line pressing the "Alt" + "Delete" key on the keyboard
-   Deleting lines by clicking on the "Remove selected lines" icon
-   Editing content of a line

### What is NOT covered by "Undo last Action"?

-   Deleting data by clicking on the "Reset Lines" / "Reset Data" / "Reset All" icon
-   Overwritten data by an import
-	Skipping duplicates resulting out of setting changes / changed Data
-	Skipping duplicates resulting out of replacement pattern changes / changed Data
-	Removed lines by the "Max Lines" setting
-	Filtered lines by the "Filter lines without jp content" setting

### Can I move the data to another device / browser?

-   You can export/import data by clicking on the respective Icon in the settings menu
-   Clicking on the icon will export the current time value, notes, displayed lines and action history (settings will not be exported)
-   Clicking on the icon while holding the "ALT" key on the keyboard lets you select a previously exported file for import. Note that all existing data will be overwritten
-	The same steps can be executed for exporting/importing all Settings/Presets or single Presets via respective Icons


### What is the order of settings / transformations on new text lines?
1.	Replacements
2.	Remove all Whitespace
3.	Filter lines without jp content
4.	Global or last line Duplicate
5.	Max Lines
6.	Merge equal Line Starts

### Can I use the floating window in other browsers except chrome / edge?
-	No - (Desktop) Chromium Browser are currently the only browser having the required api implemented

### What options / actions are applied to the floating Window?
-	Applied: Font Size, Online Font, Max Lines (floating window),Reverse Line Order, Preserve Whitespace, Enable Line Animation, AFK Blur, Custom CSS
-	Implicit: All Line related text adjustments like replacement patterns, duplicate management, line start merges, jp content filter etc.
-	Not available: Vertical Display, Main window actions, timer / stats, keybinds, pasting and line actions like selecting or editing

### Can i let my dictionary extension exceed the floating Window?

-	No - technically the floating window behaves exactly as any other browser window and therefore it is not possible that content exceeds it

### Will the floating Window remember the last Position?

-	In Terms of height and width the page will attempt to restore the last used dimensions but the browser may clamp or ignore the values as appropriate to provide a reasonable user experience. The window position itself typically resets when closing the tab or floating window

### Can i further customize the floating Window?

-	You can apply custom styles as per standard settings. In order to target the floating window content you can use the id selector "#pip-container" (e.g. `#pip-container p {color: red;}` will only apply to paragraphs in the floating window and not the main window). Further customizations like exeeding height, transparency etc. is not possible


## Available Keybinds
Note: The actions are only executed when settings/notes are closed, no (confirmation) dialog is displayed and no line is in edit mode.

| Keybind | Description |
|-|-|
| <kbd>Delete</kbd> | Deletes current highlighted lines on the page. |
| <kbd>Esc</kbd> | Deselects Lines. |
| <kbd>Alt</kbd> + <kbd>Delete</kbd> | Deletes last line if no lines are highlighted |
| <kbd>Alt</kbd> + <kbd>a</kbd> | Deletes all Lines and resets the Timer to 00:00:00. |
| <kbd>Alt</kbd> + <kbd>q</kbd> | Deletes all Lines. |
| <kbd>Control</kbd> + <kbd>Space</kbd> | Toggles the Timer. |


## Available Settings

The following section contains explanations and details on the settings you can configure. The settings can be accessed by clicking on the gear at the top right corner.

<details style="cursor: pointer;">
    <summary>Settings List</summary>

| Setting | Description |
|-|-|
| Presets | Allows you to save the current Settings as a Preset and to quickly switch between them.<br/>**Note:** Changes to Settings needs to be manually saved to a Preset by clicking on the Save button. The Dialog to apply Settings to current Lines or Storage like "Store X persistently", "Prevent Last Line Duplicate", "Remove all Whitespace" etc. will not be triggered by switching between Presets. You can still execute them by toggling respective Setting.|
| Replacements | Allows you to configure (regex) patterns and replacements which are getting applied to new lines. See [this documentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#description) for more Information. You can change the order of patterns by holding down your mouse on the box and moving it to the item you want to swap the position with
| Window Title | Lets you set the current document title. This can be used with Yomichan to tag your created cards (with the `{document-title}` [marker](https://github.com/FooSoft/yomichan#markers-for-term-cards)). |
| Primary WebSocket | URL of the primary WebSocket to which you want to connect. |
| Secondary WebSocket | URL of the secondary WebSocket to which you want to connect. |
| Font Size | The font size, in number of pixels. |
| Character Milestone | Interval of Characters after which a milestone section will be inserted (< 2 = disabled) |
| Online Font | Lets you select a font from a predefined selection. An internet connection is required in order for this work. |
| Prevent Last Line Duplicate | This will prevent the insertion/pasting of a line if the text is equal to one of the last n configured lines. |
| Max lines | Sets the maximum number of lines allowed. Once the limit is reached, the oldest line is automatically removed when a new one is added. The feature is active only when the limit is greater than 0. Undo Action will enforce this setting on execution. |
| AFK Timer (s) | Number of seconds after which the timer will automatically pause without page interaction (no new line, text selection, or pointer move). |
| Adjust Timer after AFK | If enabled, the timer will be subtracted by the configured `AFK Timer (s)` value whenever the timer was paused due to no page interaction. |
| Enable external Clipboard Monitor | If enabled, this will allow the texthooker page to handle lines pasted by extensions like [Clipboard Inserter](https://github.com/kmltml/clipboard-inserter) or [lap-clipboard-inserter](https://github.com/laplus-sadness/lap-clipboard-inserter). |
| Show Preset Quick Switch | If enabled and you have more than 2 preset stored, this will display a preset selector in the page header for quick access to your presets. |
| Skip Reset Confirmations | If enabled, reset / delete actions like "Reset Lines" will be immediately executed without asking for confirmation. |
| Store Stats persistently | If enabled, the stats (time, speed, etc.) will be stored in your local browser storage. This means the stats will be available after tab reloads, etc. |
| Store Notes persistently | If enabled, the text within the notes section will be stored in your local browser storage. |
| Store Lines persistently | If enabled, the inserted/pasted lines will be stored in your local browser storage. |
| Store Action History persistently | If enabled, the [revertible actions](#what-is-covered-by-undo-last-action) will be stored in your local browser storage. |
| Enable Paste | If enabled, this will allow the user to manually paste new lines to the texthooker page (i.e. with ctrl+v). |
| Block Copy from Page | If enabled, this will block the next line insertion by an external clipboard monitor after copying text from the page |
| Allow Paste during Pause | If enabled, this will allow the page to paste new lines even with a paused timer. |
| Allow new Line during Pause | If enabled, this will allow the page to insert new lines from other sources than pasting even with a paused timer. |
| Autostart Timer by Paste during Pause | If enabled, the time will automatically re-start if it was paused and new lines were pasted. |
| Autostart Timer by Line during Pause | If enabled, the time will automatically re-start if it was paused and new lines were inserted by sources than pasting. |
| Prevent Global Duplicate | This is the same as "Prevent Last Line Duplicate", except the line is checked against the entire document. The line will not be inserted/pasted if it is found anywhere within the document. |
| Merge equal Line Start | If enabled, a new text line will be merged with the previous one in case it starts with the exact same content |
| Filter lines without jp content | If enabled, lines without any Japanese character or punctuation will be ignored and not added to the list of lines. |
| Flash on missed Line | If enabled, the page will flash every time a line is inserted/pasted *if your timer is paused*. These lines will be ignored from stats collection. |
| Display Text vertically | If enabled, the lines will be displayed vertically instead horizontally. |
| Reverse Line Order | If enabled, the new lines will be appended on top (horizontal mode) / left (vertical mode) instead of bottom / right respectively. |
| Preserve Whitespace | If enabled, all existing whitespace (such as spaces, new line characters, etc.) within the line will be fully displayed. If left disabled, newlines and multiple spaces in a row will be collapsed to a singular space. This has no effect if the whitespace is already removed (i.e. with the `Remove all Whitespace` option enabled). |
| Remove all Whitespace | If enabled, all whitespace will be removed from the lines before they are inserted into the page. |
| Show Timer | If enabled, the page will display the current passed (active) time in the header. |
| Show Speed | If enabled, the page will display the current characters per hour in the header. |
| Show Character Count | If enabled, the page will display the current number of displayed characters within the page. |
| Show Line Count | If enabled, the page will display the current number of inserted lines within the page. |
| Blur Stats | If enabled, the displayed stats will be blurred. These stats are unblurred on hover. |
| Enable Line Animation | If enabled, adds Lines with a short animated Transition. |
| Enable AFK Blur | If enabled the screen will be blurred when the afk timer gets activated. You can exit by double clicking/tapping on the page. |
| Restart Timer after AFK Blur | If enabled the timer will automatically restart when you exit the afk blur mode. |
| Continuous Reconnect | If enabled, supresses Connection Error Messages and retries to connect to the Websocket Url continuously. |
| Custom CSS | Lets you insert custom CSS rules to customize the page further. |

</details>

## Known Issues

-   High number of displayed characters may slow down the page performance due to the current greedy way of counting characters etc.
-   The horizontal reading mode performs overall better than the vertical one
-   Line breaks added manually during editing a line are sometimes removed
-	The page was build with desktop / maximized window usage in mind - following guides (e. g. like [this](https://rentry.co/android-texthook) one) to access the page via tablet or mobile devices / using smaller window / screen sizes may have a limited user experience or functionality

## Acknowledgements

-   [Anacreon Texthooker](https://anacreondjt.gitlab.io/texthooker.html)
-   [MarvNC texthooker-websocket User Script](https://github.com/MarvNC/texthooker-websocket)
