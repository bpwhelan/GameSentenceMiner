# Privacy Policy for JitenReader Browser Extension

Last updated: February 5, 2026

JitenReader is a browser extension that parses Japanese text on web pages using the Jiten.moe service. To provide this functionality, the extension reads Japanese text from web pages you visit and transmits it to Jiten.moe's servers for processing. All data is transmitted securely over HTTPS. This policy describes in full how user data is collected, processed, stored, and shared.

## What Data the Extension Collects

JitenReader processes the following data to provide its functionality:

- **Japanese text from web pages**: The extension reads visible Japanese text on pages you visit in order to parse and annotate it.
- **API key**: Your Jiten.moe API key, entered by you in the extension settings.
- **User preferences**: Extension settings such as keybinds, theme colours, highlighting options, and parser configuration.
- **SRS review actions**: When you grade a word or change its vocabulary state (e.g. mining, blacklisting, suspending), those actions are recorded.
- **Example sentences** (optional): If the "Set Sentences" option is enabled and you mine a word, the sentence containing that word is captured.

The extension does **not** collect browsing history, analytics, telemetry, or any data unrelated to Japanese text parsing and vocabulary management.

## How Data Is Used

- **Japanese text** is sent to the Jiten.moe API (`api.jiten.moe`) for parsing and word identification. This is the core functionality of the extension.
- **Review grades and vocabulary states** are sent to Jiten.moe to manage your spaced repetition learning progress.
- **Example sentences**, when enabled, are sent to Jiten.moe and stored with the corresponding vocabulary card.
- **Your API key and preferences** are used locally to authenticate requests and configure the extension's behaviour.

## How Data Is Stored

- All extension settings, including your API key, are stored **locally on your device** using the browser's extension storage (`chrome.storage.local`).
- No data is synced to the cloud by the extension.
- Parsed word data is held in memory only for the duration of your browsing session and is not persisted.

## Data Sharing

Data is transmitted **only to Jiten.moe** (`https://api.jiten.moe/api`) for the purposes described above. Specifically:

- Parsed Japanese text from web pages
- Word identifiers and reading indices
- SRS review grades and vocabulary state changes
- Example sentences (if enabled)

No data is shared with any other third party. The extension contains **no analytics, tracking, or advertising**.

For information on how Jiten.moe handles data on its servers, please refer to the [Jiten.moe Privacy Policy](https://jiten.moe/privacy).

## User Control

- All parsing is initiated by you, either manually or through automatic parsers you can enable or disable.
- Sentence storage is optional and controlled by the "Set Sentences" setting.
- You can disable specific parsers or configure which sites the extension is active on.
- You can delete all local extension data by clearing the extension's storage through your browser settings.
- To delete data stored on Jiten.moe's servers, manage your account at [jiten.moe](https://jiten.moe).

## Permissions

The extension requires the following browser permissions:

- **All URLs** (`<all_urls>`): Required to run the content script that identifies and annotates Japanese text on any web page you visit.
- **Storage**: To save your settings and API key locally.
- **Context Menus**: To provide a right-click "Lookup selected text" option.
- **Scripting**: To inject styles for text highlighting and popup display.

## Contact

If you have any questions about this Privacy Policy, please contact us at contact@jiten.moe.
