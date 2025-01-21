from dataclasses import dataclass

from dataclasses_json import dataclass_json

@dataclass_json
@dataclass
class SteamGame:
    id: int
    name: str
    process_name: str
    script: str


# manual_config = [
#
# ]


manual_config = [
    SteamGame(948740, "AI: The Somnium Files", "AI_TheSomniumFiles.exe", r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts\PC_Steam_Unity_AI_The_Somnium_Files.js"),
    # SteamGame(638970, "Yakuza 0", "Yakuza0.exe", r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts\PC_Steam_Yakuza.0.js")
]
auto_select = -1
