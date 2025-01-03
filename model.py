from dataclasses import dataclass
from typing import Optional, List

from dataclasses_json import dataclass_json


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

#
# @dataclass_json
# @dataclass
# class SourceActive:
#     videoActive: bool
#     videoShowing: bool

