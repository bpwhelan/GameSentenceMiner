import ctypes
import uuid

from GameSentenceMiner.util.platform import windows_audio


def test_guid_uses_windows_abi_size_on_every_platform():
    guid = windows_audio._GUID.from_string("{BCDE0395-E52F-467C-8E3D-C4579291692E}")

    assert ctypes.sizeof(windows_audio._GUID) == 16
    assert (
        ctypes.string_at(ctypes.byref(guid), ctypes.sizeof(guid))
        == uuid.UUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}").bytes_le
    )
