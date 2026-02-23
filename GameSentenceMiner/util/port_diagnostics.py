import os
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple

try:
    import psutil
except Exception:  # pragma: no cover - optional dependency fallback
    psutil = None

ADDRESS_IN_USE_ERRNOS = {48, 98, 10048}
ADDRESS_IN_USE_SNIPPETS = (
    "address already in use",
    "only one usage of each socket address",
    "error while attempting to bind on address",
)
GSM_PROCESS_MARKERS = (
    "gamesentenceminer",
    "gamesentenceminer.gsm",
    "gamesentenceminer\\gsm.py",
    "gamesentenceminer/gsm.py",
    "run_gsm.ps1",
)


@dataclass(frozen=True)
class PortOwner:
    pid: Optional[int]
    name: str
    exe: str
    cmdline: str
    host: str
    port: int


def is_address_in_use_error(error: OSError) -> bool:
    err_no = getattr(error, "errno", None)
    if err_no in ADDRESS_IN_USE_ERRNOS:
        return True

    message = str(error).lower()
    return any(snippet in message for snippet in ADDRESS_IN_USE_SNIPPETS)


def _extract_laddr(connection) -> Tuple[str, int]:
    laddr = getattr(connection, "laddr", None)
    if not laddr:
        return "", -1

    if hasattr(laddr, "ip") and hasattr(laddr, "port"):
        return str(laddr.ip or ""), int(laddr.port or -1)

    if isinstance(laddr, tuple) and len(laddr) >= 2:
        return str(laddr[0] or ""), int(laddr[1] or -1)

    return "", -1


def _is_listen_status(connection) -> bool:
    status = str(getattr(connection, "status", "") or "").upper()
    listen_token = str(getattr(psutil, "CONN_LISTEN", "LISTEN") or "LISTEN").upper()
    return status in ("", "LISTEN", listen_token)


def _host_matches(bind_host: str, listen_host: str) -> bool:
    bind_host = str(bind_host or "").strip().lower()
    listen_host = str(listen_host or "").strip().lower()

    if not bind_host or bind_host in ("0.0.0.0", "::"):
        return True
    if listen_host in ("0.0.0.0", "::"):
        return True
    if bind_host == "localhost":
        return listen_host in ("localhost", "127.0.0.1", "::1")
    if bind_host == "127.0.0.1":
        return listen_host in ("127.0.0.1", "localhost")
    if bind_host == "::1":
        return listen_host in ("::1", "localhost")
    return bind_host == listen_host


def _safe_join(parts: Iterable[str]) -> str:
    return " ".join(part for part in parts if part)


def _get_process_details(pid: Optional[int]) -> Tuple[str, str, str]:
    if not pid or psutil is None:
        return "", "", ""

    try:
        process = psutil.Process(pid)
        with process.oneshot():
            name = process.name() or ""
            exe = process.exe() or ""
            cmdline = _safe_join(process.cmdline())
            return name, exe, cmdline
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
        return "", "", ""


def find_port_owners(port: int, bind_host: str = "127.0.0.1") -> List[PortOwner]:
    if psutil is None:
        return []

    try:
        connections = psutil.net_connections(kind="tcp")
    except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
        return []

    owners: List[PortOwner] = []
    seen: set = set()
    for connection in connections:
        listen_host, listen_port = _extract_laddr(connection)
        if listen_port != port:
            continue
        if not _is_listen_status(connection):
            continue
        if not _host_matches(bind_host, listen_host):
            continue

        pid = getattr(connection, "pid", None)
        dedupe_key = pid if pid is not None else (listen_host, listen_port)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        name, exe, cmdline = _get_process_details(pid)
        owners.append(
            PortOwner(
                pid=pid,
                name=name,
                exe=exe,
                cmdline=cmdline,
                host=listen_host,
                port=listen_port,
            )
        )

    return owners


def is_probably_gsm_process(owner: PortOwner) -> bool:
    haystack = _safe_join((owner.name, owner.exe, owner.cmdline)).lower()
    return any(marker in haystack for marker in GSM_PROCESS_MARKERS)


def describe_port_owners(owners: List[PortOwner]) -> str:
    if not owners:
        return "unknown process"

    parts = []
    for owner in owners:
        pid_text = f"PID {owner.pid}" if owner.pid else "PID unknown"
        name_text = owner.name or "unknown"
        host_text = owner.host or "unknown-host"
        parts.append(f"{name_text} ({pid_text}, {host_text}:{owner.port})")
    return ", ".join(parts)


def terminate_process(pid: Optional[int], timeout_seconds: float = 3.0) -> bool:
    if psutil is None or not pid or pid <= 0 or pid == os.getpid():
        return False

    try:
        process = psutil.Process(pid)
        process.terminate()
        process.wait(timeout=timeout_seconds)
        return True
    except psutil.NoSuchProcess:
        return True
    except psutil.TimeoutExpired:
        try:
            process.kill()
            process.wait(timeout=timeout_seconds)
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            return False
    except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
        return False
