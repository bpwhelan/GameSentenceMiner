"""Recommended note types and their mining presets.

Packages come from the authors' GitHub releases. Use Anki's native importer:
AnkiConnect's legacy importPackage action can report success after importing only
the compatibility warning from a modern (collection.anki21b) package.
"""

from __future__ import annotations

import hashlib
import tempfile
import time
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests


class AnkiSetupError(RuntimeError):
    pass


@dataclass(frozen=True)
class CardTypePreset:
    id: str
    name: str
    repository: str
    documentation: str
    description: str
    gsm_fields: dict[str, str]
    yomitan_fields: dict[str, str]


_LAPIS_FIELDS = {
    "Expression": "{expression}",
    "ExpressionFurigana": "{furigana-plain}",
    "ExpressionReading": "{reading}",
    "ExpressionAudio": "{audio}",
    "SelectionText": "{popup-selection-text}",
    "MainDefinition": "",
    "DefinitionPicture": "",
    "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
    "SentenceFurigana": "",
    "SentenceAudio": "",
    "Picture": "",
    "Glossary": "{glossary}",
    "Hint": "",
    "IsWordAndSentenceCard": "",
    "IsClickCard": "",
    "IsSentenceCard": "",
    "IsAudioCard": "",
    "PitchPosition": "{pitch-accent-positions}",
    "PitchCategories": "{pitch-accent-categories}",
    "Frequency": "{frequencies}",
    "FreqSort": "{frequency-harmonic-rank}",
    "MiscInfo": "{document-title}",
}
_LAPIS_GSM_FIELDS = {
    "word": "Expression",
    "sentence": "Sentence",
    "sentence_audio": "SentenceAudio",
    "picture": "Picture",
    "sentence_furigana": "SentenceFurigana",
    "game_name": "MiscInfo",
}

PRESETS = (
    CardTypePreset(
        "lapis",
        "Lapis",
        "donkuri/lapis",
        "https://github.com/donkuri/lapis#how-to-use-lapis",
        "A lightweight card with dictionary switching, pitch accents and frequency information.",
        dict(_LAPIS_GSM_FIELDS),
        dict(_LAPIS_FIELDS),
    ),
    CardTypePreset(
        "kiku",
        "Kiku",
        "youyoumu/kiku",
        "https://kiku.youyoumu.my.id/installation.html",
        "Interactive cards with related expressions and field grouping. Requires Anki 25.09 or later. "
        "The optional Kiku Note Manager add-on enables the Kanji Web cache.",
        dict(_LAPIS_GSM_FIELDS),
        {
            **_LAPIS_FIELDS,
            "SentenceFurigana": "{sentence-furigana-plain}",
            "SentenceTranslation": "",
            "RelatedExpression": "",
        },
    ),
    CardTypePreset(
        "senren",
        "Senren",
        "BrenoAqua/Senren",
        "https://brenoaqua.github.io/Senren/yomitan/",
        "Customizable cards with dictionary switching, pitch accents and display preferences.",
        {
            "word": "word",
            "sentence": "sentence",
            "sentence_audio": "sentenceAudio",
            "picture": "picture",
            "sentence_furigana": "sentenceFurigana",
            "game_name": "miscInfo",
        },
        {
            "word": "{expression}",
            "reading": "{reading}",
            "sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
            "sentenceFurigana": "{sentence-furigana-plain}",
            "sentenceTranslation": "",
            "sentenceCard": "",
            "audioCard": "",
            "notes": "",
            "hint": "",
            "selectionText": "{popup-selection-text}",
            "definition": "",
            "wordAudio": "{audio}",
            "sentenceAudio": "",
            "picture": "",
            "glossary": "{glossary}",
            "pitchAccents": "{pitch-accents}",
            "pitchPositions": "{pitch-accent-positions}",
            "pitchCategories": "{pitch-accent-categories}",
            "frequencies": "{frequencies}",
            "freqSort": "{frequency-harmonic-rank}",
            "miscInfo": "{document-title}",
            "dictionaryPreference": "",
        },
    ),
)


def get_preset(preset_id: str) -> CardTypePreset:
    for preset in PRESETS:
        if preset.id == preset_id:
            return preset
    raise AnkiSetupError("Choose Lapis, Kiku or Senren.")


def suggest_gsm_field_mappings(fields: Iterable[str]) -> dict[str, str]:
    """Recognize compatible field layouts, including renamed/customized note types."""
    field_names = set(fields)
    # Lapis and Kiku use the same core GSM fields. No model-name check is needed.
    matches = [
        preset
        for preset in (get_preset("lapis"), get_preset("senren"))
        if set(preset.gsm_fields.values()).issubset(field_names)
    ]
    if len(matches) != 1:
        return {}
    preset = matches[0]
    mappings = dict(preset.gsm_fields)
    translation_fields = ("sentenceTranslation", "sentenceEng") if preset.id == "senren" else ("SentenceTranslation",)
    for field in translation_fields:
        if field in field_names:
            mappings["ai"] = field
            break
    return mappings


@dataclass(frozen=True)
class SetupResult:
    preset_id: str
    model_name: str = ""
    fields: tuple[str, ...] = ()
    deck: str = ""
    import_pending: bool = False
    package_path: str = ""

    @property
    def yomitan_fields(self) -> dict[str, str]:
        values = dict(get_preset(self.preset_id).yomitan_fields)
        if self.preset_id == "senren":
            # Senren v5 renamed these fields; setup also reuses installed v4 models.
            # https://github.com/BrenoAqua/Senren/releases/tag/v5.0.0
            for old, new in {
                "sentenceEng": "sentenceTranslation",
                "pitchPosition": "pitchPositions",
                "pitch": "pitchCategories",
                "frequency": "frequencies",
            }.items():
                values[old] = values[new]
            if "pitch" in self.fields and "pitchAccents" not in self.fields:
                values["reading"] = values["pitchAccents"]
        return {name: values.get(name, "") for name in self.fields}

    def yomitan_payload(self, url: str) -> dict:
        if self.import_pending or not self.model_name or not self.fields:
            raise AnkiSetupError("Complete the Anki import first.")
        preset = get_preset(self.preset_id)
        return {
            "preset": preset.id,
            "model": self.model_name,
            "deck": self.deck,
            "server": url,
            "fields": self.yomitan_fields,
        }


class AnkiSetupClient:
    MAX_PACKAGE_BYTES = 64 * 1024 * 1024

    def __init__(self, url: str, download_directory: Path):
        self.url = url.strip()
        if urlparse(self.url).scheme not in ("http", "https") or not urlparse(self.url).hostname:
            raise AnkiSetupError("Enter an HTTP or HTTPS AnkiConnect URL.")
        self.download_directory = Path(download_directory)
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "GameSentenceMiner-AnkiSetup"

    def invoke(self, action: str, **params):
        try:
            response = self.session.post(
                self.url, json={"action": action, "version": 6, "params": params}, timeout=(5, 30)
            )
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as error:
            raise AnkiSetupError(
                "Could not reach AnkiConnect. Open Anki, install/enable AnkiConnect, and check the URL above."
            ) from error
        if not isinstance(data, dict) or "error" not in data or "result" not in data:
            raise AnkiSetupError("Unexpected AnkiConnect response. Check the URL and update AnkiConnect.")
        if data["error"]:
            raise AnkiSetupError(f"AnkiConnect: {data['error']}")
        return data["result"]

    def check(self) -> list[str]:
        version = self.invoke("version")
        if not isinstance(version, int) or version < 6:
            raise AnkiSetupError("Update AnkiConnect to a version supporting API 6.")
        return self._names("deckNames")

    def _names(self, action: str, **params) -> list[str]:
        names = self.invoke(action, **params)
        if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
            raise AnkiSetupError(f"AnkiConnect returned invalid data for {action}.")
        return names

    def setup(self, preset_id: str, deck: str, *, allow_download=True) -> SetupResult:
        preset = get_preset(preset_id)
        deck = deck.strip()
        if not deck:
            raise AnkiSetupError("Choose or enter a deck for new cards.")
        self.check()
        models = self._names("modelNames")
        model = next((name for name in models if name.casefold() == preset.name.casefold()), None)
        if model is None:
            if not allow_download:
                raise AnkiSetupError(f"Finish importing {preset.name} in Anki, then click Finish setup again.")
            if urlparse(self.url).hostname not in ("localhost", "127.0.0.1", "::1"):
                raise AnkiSetupError(
                    "Automatic import requires Anki on the same computer as GSM. "
                    "Import the official package on your Anki computer, then retry."
                )
            package = self.download(preset)
            self.invoke("guiImportFile", path=package.as_posix())
            return SetupResult(preset_id, deck=deck, import_pending=True, package_path=str(package))
        fields = self._names("modelFieldNames", modelName=model)
        required = set(preset.gsm_fields.values()) | {"Glossary" if preset_id != "senren" else "glossary"}
        missing = sorted(required - set(fields))
        if missing:
            raise AnkiSetupError(
                f"{model} is missing required fields: {', '.join(missing)}. "
                "Check its official setup guide before retrying; GSM has left its templates unchanged."
            )
        if deck not in self._names("deckNames"):
            self.invoke("createDeck", deck=deck)
            if deck not in self._names("deckNames"):
                raise AnkiSetupError("Anki did not create the selected deck. Please create it in Anki and retry.")
        return SetupResult(preset_id, model, tuple(fields), deck)

    def download(self, preset: CardTypePreset) -> Path:
        """Validate a release package before handing its local path to Anki."""
        temporary = None
        try:
            response = self.session.get(
                f"https://api.github.com/repos/{preset.repository}/releases/latest", timeout=(5, 20)
            )
            response.raise_for_status()
            release = response.json()
            assets = [
                asset
                for asset in release.get("assets", [])
                if str(asset.get("name", "")).lower().endswith(".apkg")
                and str(asset.get("name", "")).lower().startswith(preset.id)
            ]
            if len(assets) != 1:
                raise AnkiSetupError("The official release has no unambiguous Anki package. Open its setup guide.")
            asset = assets[0]
            url = urlparse(asset["browser_download_url"])
            if (
                url.scheme != "https"
                or url.netloc != "github.com"
                or not url.path.startswith(f"/{preset.repository}/releases/download/")
            ):
                raise AnkiSetupError("The release package URL is not from the official repository.")
            expected_size = asset.get("size")
            if not isinstance(expected_size, int) or not 0 < expected_size <= self.MAX_PACKAGE_BYTES:
                raise AnkiSetupError("The release package is empty or exceeds the 64 MB download limit.")
            self.download_directory.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            deadline = time.monotonic() + 120
            with tempfile.NamedTemporaryFile(dir=self.download_directory, suffix=".download", delete=False) as output:
                temporary = Path(output.name)
                size = 0
                with self.session.get(asset["browser_download_url"], stream=True, timeout=(5, 30)) as package:
                    package.raise_for_status()
                    for chunk in package.iter_content(128 * 1024):
                        if time.monotonic() > deadline:
                            raise AnkiSetupError("The download took too long. Check your connection and retry.")
                        size += len(chunk)
                        if size > self.MAX_PACKAGE_BYTES or size > expected_size:
                            raise AnkiSetupError("The downloaded package exceeds its expected size.")
                        digest.update(chunk)
                        output.write(chunk)
            if size != expected_size:
                raise AnkiSetupError("The download was incomplete. Retry the installation.")
            expected_digest = asset.get("digest")
            if expected_digest and expected_digest != f"sha256:{digest.hexdigest()}":
                raise AnkiSetupError("The download checksum does not match the official release.")
            if not zipfile.is_zipfile(temporary):
                raise AnkiSetupError("The download is not an Anki package.")
            with zipfile.ZipFile(temporary) as archive:
                members = set(archive.namelist())
                if "media" not in members or not members.intersection(
                    {"collection.anki2", "collection.anki21", "collection.anki21b"}
                ):
                    raise AnkiSetupError("The download does not contain an Anki collection.")
            destination = self.download_directory / f"{preset.name}-{digest.hexdigest()[:16]}.apkg"
            temporary.replace(destination)
            return destination
        except (requests.RequestException, ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
            raise AnkiSetupError(
                "Could not download the official Anki package. Check your connection and retry."
            ) from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def close(self):
        self.session.close()
