from __future__ import annotations

import ctypes
import uuid
from ctypes import wintypes
from dataclasses import dataclass
from typing import Iterable, Optional

from GameSentenceMiner.util.config.configuration import is_windows, logger


if is_windows():
    _ole32 = ctypes.WinDLL("ole32")
else:
    _ole32 = None


_COM_METHOD = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
_HRESULT = ctypes.c_long
_CLSCTX_ALL = 0x17
_DEVICE_STATE_ACTIVE = 0x00000001
_E_RENDER = 0
_RPC_E_CHANGED_MODE = -2147417850


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8),
    ]

    @classmethod
    def from_string(cls, value: str) -> "_GUID":
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


_CLSID_MMDEVICE_ENUMERATOR = _GUID.from_string("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
_IID_IMMDEVICE_ENUMERATOR = _GUID.from_string("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
_IID_IAUDIO_SESSION_MANAGER2 = _GUID.from_string("{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}")
_IID_IAUDIO_SESSION_CONTROL2 = _GUID.from_string("{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}")
_IID_ISIMPLE_AUDIO_VOLUME = _GUID.from_string("{87CE5498-68D6-44E5-9215-6DA47EF883D8}")

if _ole32 is not None:
    _ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    _ole32.CoInitializeEx.restype = _HRESULT
    _ole32.CoUninitialize.argtypes = []
    _ole32.CoUninitialize.restype = None
    _ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(_GUID),
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    _ole32.CoCreateInstance.restype = _HRESULT
    _ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    _ole32.CoTaskMemFree.restype = None


@dataclass(frozen=True)
class ProcessMuteResult:
    pid: int
    session_instance_id: str
    previous_muted: bool
    changed: bool


def _failed(hr: int) -> bool:
    return int(hr) < 0


def _method(ptr: ctypes.c_void_p, index: int, restype, *argtypes):
    vtable = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return _COM_METHOD(restype, ctypes.c_void_p, *argtypes)(vtable[index])


def _release(ptr: Optional[ctypes.c_void_p]) -> None:
    if not ptr:
        return
    try:
        _method(ptr, 2, wintypes.ULONG)(ptr)
    except Exception:
        pass


def _query_interface(ptr: ctypes.c_void_p, iid: _GUID) -> Optional[ctypes.c_void_p]:
    out = ctypes.c_void_p()
    hr = _method(ptr, 0, _HRESULT, ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p))(
        ptr,
        ctypes.byref(iid),
        ctypes.byref(out),
    )
    if _failed(hr) or not out:
        return None
    return out


def _get_session_instance_id(control2: ctypes.c_void_p) -> str:
    value = wintypes.LPWSTR()
    hr = _method(control2, 13, _HRESULT, ctypes.POINTER(wintypes.LPWSTR))(control2, ctypes.byref(value))
    if _failed(hr) or not value:
        return ""
    try:
        return value.value or ""
    finally:
        try:
            _ole32.CoTaskMemFree(ctypes.cast(value, ctypes.c_void_p))
        except Exception:
            pass


def _iter_render_audio_session_controls() -> Iterable[ctypes.c_void_p]:
    device_enumerator = ctypes.c_void_p()
    endpoint_collection = ctypes.c_void_p()
    co_initialized = False

    hr = _ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
    if hr in (0, 1):
        co_initialized = True
    elif hr != _RPC_E_CHANGED_MODE and _failed(hr):
        raise OSError(f"CoInitializeEx failed: 0x{int(hr) & 0xFFFFFFFF:08X}")

    try:
        hr = _ole32.CoCreateInstance(
            ctypes.byref(_CLSID_MMDEVICE_ENUMERATOR),
            None,
            _CLSCTX_ALL,
            ctypes.byref(_IID_IMMDEVICE_ENUMERATOR),
            ctypes.byref(device_enumerator),
        )
        if _failed(hr) or not device_enumerator:
            raise OSError(f"CoCreateInstance(MMDeviceEnumerator) failed: 0x{int(hr) & 0xFFFFFFFF:08X}")

        hr = _method(
            device_enumerator,
            3,
            _HRESULT,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(ctypes.c_void_p),
        )(device_enumerator, _E_RENDER, _DEVICE_STATE_ACTIVE, ctypes.byref(endpoint_collection))
        if _failed(hr) or not endpoint_collection:
            return

        endpoint_count = wintypes.UINT()
        hr = _method(endpoint_collection, 3, _HRESULT, ctypes.POINTER(wintypes.UINT))(
            endpoint_collection,
            ctypes.byref(endpoint_count),
        )
        if _failed(hr):
            return

        for endpoint_index in range(int(endpoint_count.value)):
            endpoint = ctypes.c_void_p()
            session_manager = ctypes.c_void_p()
            session_enumerator = ctypes.c_void_p()
            try:
                hr = _method(endpoint_collection, 4, _HRESULT, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p))(
                    endpoint_collection,
                    endpoint_index,
                    ctypes.byref(endpoint),
                )
                if _failed(hr) or not endpoint:
                    continue

                hr = _method(
                    endpoint,
                    3,
                    _HRESULT,
                    ctypes.POINTER(_GUID),
                    wintypes.DWORD,
                    ctypes.c_void_p,
                    ctypes.POINTER(ctypes.c_void_p),
                )(
                    endpoint,
                    ctypes.byref(_IID_IAUDIO_SESSION_MANAGER2),
                    _CLSCTX_ALL,
                    None,
                    ctypes.byref(session_manager),
                )
                if _failed(hr) or not session_manager:
                    continue

                hr = _method(session_manager, 5, _HRESULT, ctypes.POINTER(ctypes.c_void_p))(
                    session_manager,
                    ctypes.byref(session_enumerator),
                )
                if _failed(hr) or not session_enumerator:
                    continue

                session_count = ctypes.c_int()
                hr = _method(session_enumerator, 3, _HRESULT, ctypes.POINTER(ctypes.c_int))(
                    session_enumerator,
                    ctypes.byref(session_count),
                )
                if _failed(hr):
                    continue

                for session_index in range(int(session_count.value)):
                    control = ctypes.c_void_p()
                    hr = _method(session_enumerator, 4, _HRESULT, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(
                        session_enumerator,
                        session_index,
                        ctypes.byref(control),
                    )
                    if _failed(hr) or not control:
                        continue
                    yield control
            finally:
                _release(session_enumerator)
                _release(session_manager)
                _release(endpoint)
    finally:
        _release(endpoint_collection)
        _release(device_enumerator)
        if co_initialized:
            _ole32.CoUninitialize()


def set_process_mute(
    pid: int,
    muted: bool,
    session_instance_ids: Optional[set[str]] = None,
) -> list[ProcessMuteResult]:
    """
    Set mute on active Windows audio sessions owned by pid.

    When session_instance_ids is provided, only those session instances are touched.
    This lets callers restore only sessions they previously muted.
    """
    if not is_windows() or _ole32 is None:
        return []

    try:
        target_pid = int(pid)
    except (TypeError, ValueError):
        return []
    if target_pid <= 0:
        return []

    wanted_session_ids = set(session_instance_ids or ())
    filter_by_session_id = session_instance_ids is not None
    results: list[ProcessMuteResult] = []

    try:
        for control in _iter_render_audio_session_controls():
            control2 = ctypes.c_void_p()
            simple_volume = ctypes.c_void_p()
            try:
                control2 = _query_interface(control, _IID_IAUDIO_SESSION_CONTROL2)
                if not control2:
                    continue

                session_pid = wintypes.DWORD()
                hr = _method(control2, 14, _HRESULT, ctypes.POINTER(wintypes.DWORD))(
                    control2,
                    ctypes.byref(session_pid),
                )
                if _failed(hr) or int(session_pid.value) != target_pid:
                    continue

                session_instance_id = _get_session_instance_id(control2)
                if filter_by_session_id and session_instance_id not in wanted_session_ids:
                    continue

                simple_volume = _query_interface(control, _IID_ISIMPLE_AUDIO_VOLUME) or _query_interface(
                    control2,
                    _IID_ISIMPLE_AUDIO_VOLUME,
                )
                if not simple_volume:
                    continue

                previous_muted = wintypes.BOOL()
                hr = _method(simple_volume, 6, _HRESULT, ctypes.POINTER(wintypes.BOOL))(
                    simple_volume,
                    ctypes.byref(previous_muted),
                )
                if _failed(hr):
                    continue

                previous = bool(previous_muted.value)
                changed = previous != bool(muted)
                if changed:
                    hr = _method(simple_volume, 5, _HRESULT, wintypes.BOOL, ctypes.c_void_p)(
                        simple_volume,
                        bool(muted),
                        None,
                    )
                    if _failed(hr):
                        continue

                results.append(
                    ProcessMuteResult(
                        pid=target_pid,
                        session_instance_id=session_instance_id,
                        previous_muted=previous,
                        changed=changed,
                    )
                )
            finally:
                _release(simple_volume)
                _release(control2)
                _release(control)
    except Exception as e:
        logger.debug(f"Failed to set Windows audio mute for PID {target_pid}: {e}")

    return results
