from dataclasses import dataclass
from typing import Optional, List
from enum import Enum

from dataclasses_json import dataclass_json

from GameSentenceMiner.util.configuration import get_config, logger, save_current_config


# OBS
@dataclass_json
@dataclass
class SceneInfo:
    currentProgramSceneName: str
    currentProgramSceneUuid: str
    sceneName: str
    sceneUuid: str


@dataclass_json
@dataclass
class SceneItemTransform:
    alignment: int
    boundsAlignment: int
    boundsHeight: float
    boundsType: str
    boundsWidth: float
    cropBottom: int
    cropLeft: int
    cropRight: int
    cropToBounds: bool
    cropTop: int
    height: float
    positionX: float
    positionY: float
    rotation: float
    scaleX: float
    scaleY: float
    sourceHeight: float
    sourceWidth: float
    width: float


@dataclass_json
@dataclass
class SceneItem:
    inputKind: str
    isGroup: Optional[bool]
    sceneItemBlendMode: str
    sceneItemEnabled: bool
    sceneItemId: int
    sceneItemIndex: int
    sceneItemLocked: bool
    sceneItemTransform: SceneItemTransform
    sourceName: str
    sourceType: str
    sourceUuid: str

    # def __init__(self, **kwargs):
    #     self.inputKind = kwargs['inputKind']
    #     self.isGroup = kwargs['isGroup']
    #     self.sceneItemBlendMode = kwargs['sceneItemBlendMode']
    #     self.sceneItemEnabled = kwargs['sceneItemEnabled']
    #     self.sceneItemId = kwargs['sceneItemId']
    #     self.sceneItemIndex = kwargs['sceneItemIndex']
    #     self.sceneItemLocked = kwargs['sceneItemLocked']
    #     self.sceneItemTransform = SceneItemTransform(**kwargs['sceneItemTransform'])
    #     self.sourceName = kwargs['sourceName']
    #     self.sourceType = kwargs['sourceType']
    #     self.sourceUuid = kwargs['sourceUuid']


@dataclass_json
@dataclass
class SceneItemsResponse:
    sceneItems: List[SceneItem]

    # def __init__(self, **kwargs):
    #     self.sceneItems = [SceneItem(**item) for item in kwargs['sceneItems']]


@dataclass_json
@dataclass
class RecordDirectory:
    recordDirectory: str


@dataclass_json
@dataclass
class SceneItemInfo:
    sceneIndex: int
    sceneName: str
    sceneUuid: str


@dataclass_json
@dataclass
class SceneListResponse:
    scenes: List[SceneItemInfo]
    currentProgramSceneName: Optional[str] = None
    currentProgramSceneUuid: Optional[str] = None
    currentPreviewSceneName: Optional[str] = None
    currentPreviewSceneUuid: Optional[str] = None

#
# @dataclass_json
# @dataclass
# class SourceActive:
#     videoActive: bool
#     videoShowing: bool

@dataclass_json
@dataclass
class AnkiField:
    value: str
    order: int

@dataclass_json
@dataclass
class AnkiCard:
    noteId: int
    tags: list[str]
    fields: dict[str, AnkiField]
    cards: list[int]
    alternatives = {
        "word_field": ["Front", "Word", "TargetWord", "Expression"],
        "sentence_field": ["Example", "Context", "Back", "Sentence"],
        "picture_field": ["Image", "Visual", "Media", "Picture", "Screenshot", 'AnswerImage'],
        "sentence_audio_field": ["SentenceAudio"]
    }

    def get_field(self, field_name: str) -> str:
        if self.has_field(field_name):
            return self.fields[field_name].value
        else:
            raise ValueError(f"Field '{field_name}' not found in AnkiCard. Please make sure your Anki Field Settings in GSM Match your fields in your Anki Note!")

    def has_field (self, field_name: str) -> bool:
        return field_name in self.fields

    def __post_init__(self):
        config = get_config()
        changes_found = False
        if not self.has_field(config.anki.word_field):
            found_alternative_field, field = self.find_field(config.anki.word_field, "word_field")
            if found_alternative_field:
                logger.warning(f"{config.anki.word_field} Not found in Anki Card! Saving alternative field '{field}' for word_field to settings.")
                config.anki.word_field = field
                changes_found = True

        if not self.has_field(config.anki.sentence_field):
            found_alternative_field, field = self.find_field(config.anki.sentence_field, "sentence_field")
            if found_alternative_field:
                logger.warning(f"{config.anki.sentence_field} Not found in Anki Card! Saving alternative field '{field}' for sentence_field to settings.")
                config.anki.sentence_field = field
                changes_found = True

        if not self.has_field(config.anki.picture_field):
            found_alternative_field, field = self.find_field(config.anki.picture_field, "picture_field")
            if found_alternative_field:
                logger.warning(f"{config.anki.picture_field} Not found in Anki Card! Saving alternative field '{field}' for picture_field to settings.")
                config.anki.picture_field = field
                changes_found = True

        if not self.has_field(config.anki.sentence_audio_field):
            found_alternative_field, field = self.find_field(config.anki.sentence_audio_field, "sentence_audio_field")
            if found_alternative_field:
                logger.warning(f"{config.anki.sentence_audio_field} Not found in Anki Card! Saving alternative field '{field}' for sentence_audio_field to settings.")
                config.anki.sentence_audio_field = field
                changes_found = True

        if changes_found:
            save_current_config(config)

    def find_field(self, field, field_type):
        if field in self.fields:
            return False, field

        for alt_field in self.alternatives[field_type]:
            for key in self.fields:
                if alt_field.lower() == key.lower():
                    return True, key

        return False, None


class VADResult:
    def __init__(self, success: bool, start: float, end: float, model: str, segments: list = None, output_audio: str = None, trimmed_audio_path: str = None, tts_used: bool = False):
        self.success = success
        self.start = start
        self.end = end
        self.model = model
        self.segments = segments if segments is not None else []
        self.output_audio = output_audio
        self.trimmed_audio_path = None  # Path to trimmed audio before VAD processing (for manual selection)
        self.tts_used = tts_used  # Whether TTS was used for generating audio

    def __repr__(self):
        return f"VADResult(success={self.success}, start={self.start}, end={self.end}, model={self.model}, output_audio={self.output_audio}, trimmed_audio_path={self.trimmed_audio_path}, tts_used={self.tts_used})"

    def trim_successful_string(self):
        if self.success:
            if get_config().vad.trim_beginning:
                return f"Trimmed audio from {self.start:.2f} to {self.end:.2f} seconds using {self.model}."
            else:
                return f"Trimmed end of audio to {self.end:.2f} seconds using {self.model}."
        else:
            return f"Failed to trim audio using {self.model}."
