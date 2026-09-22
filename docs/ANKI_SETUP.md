# Recommended Anki card setup

For an installed note type, select **Anki Note Type** in **Key Settings** or **Anki → General**. GSM reads its fields and offers to update compatible Lapis, Kiku or Senren mappings, even if the model has been renamed. The confirmation shows each changed field as its current and proposed value. Choose **Update fields** to apply and autosave, or **Keep current fields** to retain your mappings.

This shortcut updates field names, including the AI translation field when available. It preserves capture toggles, append/overwrite policies, field grouping and other settings. It does not configure Yomitan or install packages. Already-correct mappings, incomplete layouts and ambiguous layouts do not trigger a prompt.

## Install and configure a recommended card type

Open **GSM Settings → Anki → General → Set up recommended cards**.

1. Run Anki with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) installed. Use the AnkiConnect URL shown in GSM's Anki settings.
2. Choose Lapis, Kiku or Senren. Select an existing deck, or enter a name to create one. Review the GSM and Yomitan field tables.
3. Click **Install and set up**. If the note type is missing, GSM downloads the author's latest stable `.apkg` and opens Anki's import screen. Complete that import and click **Finish setup** in GSM.
4. GSM verifies the note type and saves its field mappings. With the Yomitan checkbox selected, the running GSM overlay also creates and selects a separate **GSM - Lapis**, **GSM - Kiku** or **GSM - Senren** profile.

If a matching note type is already installed, GSM reuses it without importing or replacing its templates. Updating an existing note type is a separate operation; follow the author's update guide. Packages may include sample cards and decks, which GSM leaves in place. No existing notes are converted or deleted.

The native import step matters: AnkiConnect's legacy `importPackage` can read the compatibility collection in a modern package instead of importing its actual note type. GSM uses `guiImportFile` and verifies the real model and required fields before changing settings. Automatic download/import needs Anki on the same computer as GSM; a remote Anki instance can be configured after importing the package on that computer.

## Applied GSM settings

| Setting | Lapis / Kiku | Senren |
| --- | --- | --- |
| Word | Expression | word |
| Sentence | Sentence | sentence |
| Sentence audio | SentenceAudio | sentenceAudio |
| Screenshot | Picture | picture |
| Sentence furigana | SentenceFurigana | sentenceFurigana |
| Game / source name | MiscInfo | miscInfo |

Anki updates are enabled, and the mapped context fields use overwrite mode. Audio and screenshot capture toggles, tags and confirmation preferences are preserved. Optional video/previous-context mappings absent from the new model are cleared. AI output maps to `SentenceTranslation` / `sentenceTranslation` when present, without enabling AI. If the existing AI field is unsupported and there is no translation field, adding AI output to Anki is disabled. GSM's field grouping is retained only for Kiku, whose `data-group-id` format it supports.

Existing Senren v4 models are supported: AI output uses `sentenceEng`, and Yomitan maps `pitchPosition`, `pitch`, `frequency` and the older pitch-based `reading` field. After setup, the field table and its copy action use the fields actually installed in Anki. See the [Senren v5 field renames](https://github.com/BrenoAqua/Senren/releases/tag/v5.0.0).

## Yomitan

Automatic configuration applies to **Yomitan inside the running GSM overlay**. It copies the active profile's dictionaries and other lookup preferences into a separate mining profile. Previous profiles remain intact. Retrying the same setup reuses an identical generated profile; changing a customized generated mapping creates a new numbered profile. Browser Yomitan and other overlay readers are not changed.

The new profile enables Anki, sets its server/deck/model, uses built-in field templates and groups results for the glossary. It keeps existing Yomitan tags and adds any tags required by GSM's card filter. Word audio comes from Yomitan; sentence audio and screenshots are left blank for GSM. `Glossary` / `glossary` contains all enabled definition dictionaries. MainDefinition / definition stays blank so the setup does not assume a particular dictionary is installed. You can select a primary dictionary afterward. Pitch/frequency fields need suitable dictionaries already installed.

Setup configures every term entry in Yomitan's `anki.cardFormats`, including both Expression and Reading buttons, with structured field values and the default `coalesce` overwrite mode. Kanji formats are preserved. Setup verifies the saved deck, model and all field values before reporting success. If an earlier GSM setup left the old fields or deck in place, restart the overlay to load the fix, then run setup again; it creates and selects a corrected profile while keeping the previous one.

For browser Yomitan, use **Copy Yomitan field table** and the official guide. Select the model and deck in Yomitan's **Anki → Configure Anki flashcards**, then paste the individual field values. The copied table is a reference, not a full Yomitan settings import.

GSM reports overlay failures separately after saving its own settings. Start the overlay with Yomitan selected, then use **Apply settings again** to retry. A missing response is never shown as successful Yomitan setup.

## Official sources

- [Lapis setup and releases](https://github.com/donkuri/lapis#how-to-use-lapis)
- [Kiku installation](https://kiku.youyoumu.my.id/installation.html) — Anki 25.09 or later; the optional Kiku Note Manager enables its Kanji Web cache.
- [Senren Yomitan setup](https://brenoaqua.github.io/Senren/yomitan/) and [releases](https://github.com/BrenoAqua/Senren/releases)

Downloads use an allowlisted repository, a 64 MB limit, size checks, GitHub's SHA-256 digest when supplied, and package-structure validation. Cached packages live under the GSM data directory's `downloads/anki-note-types/` so Anki's asynchronous import can finish reading them.

## Validation

```powershell
.venv/Scripts/python.exe -m pytest tests/test_anki_setup.py tests/ui/test_recommended_anki_dialog.py tests/util/test_anki_yomitan.py
node --test GSM_Overlay/tests/anki_setup.test.cjs
node GSM_Overlay/tests/run-anki-setup-electron-smoke.cjs
uv run ruff format GameSentenceMiner tests scripts
```

The Electron smoke test uses the actual bundled Yomitan in a disposable profile, with HTTP traffic blocked. It starts with an old deck, model and fields, then checks all saved term card formats, the already-open settings page, the profile resolved for lookups, profile preservation and retry behavior without accessing a user's Anki collection or Yomitan settings.
