from types import SimpleNamespace

from GameSentenceMiner.util import port_diagnostics


class _NullContext:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_is_address_in_use_error_detects_errno_and_message():
    assert port_diagnostics.is_address_in_use_error(OSError(10048, "Address already in use"))
    assert port_diagnostics.is_address_in_use_error(
        OSError(13, "error while attempting to bind on address ('127.0.0.1', 55001)")
    )
    assert not port_diagnostics.is_address_in_use_error(OSError(2, "No such file or directory"))


def test_is_probably_gsm_process_uses_process_markers():
    gsm_owner = port_diagnostics.PortOwner(
        pid=1234,
        name="python.exe",
        exe=r"C:\\Python\\python.exe",
        cmdline="python -m GameSentenceMiner.gsm",
        host="127.0.0.1",
        port=55001,
    )
    not_gsm_owner = port_diagnostics.PortOwner(
        pid=8888,
        name="chrome.exe",
        exe=r"C:\\Program Files\\Google\\Chrome\\chrome.exe",
        cmdline="chrome --type=renderer",
        host="127.0.0.1",
        port=55001,
    )

    assert port_diagnostics.is_probably_gsm_process(gsm_owner)
    assert not port_diagnostics.is_probably_gsm_process(not_gsm_owner)


def test_find_port_owners_filters_port_and_bind_host(monkeypatch):
    connections = [
        SimpleNamespace(
            laddr=SimpleNamespace(ip="127.0.0.1", port=55001),
            status="LISTEN",
            pid=101,
        ),
        SimpleNamespace(
            laddr=SimpleNamespace(ip="0.0.0.0", port=55001),
            status="LISTEN",
            pid=202,
        ),
        SimpleNamespace(
            laddr=SimpleNamespace(ip="127.0.0.1", port=55099),
            status="LISTEN",
            pid=303,
        ),
        SimpleNamespace(
            laddr=SimpleNamespace(ip="::1", port=55001),
            status="LISTEN",
            pid=404,
        ),
    ]

    class FakeProcess:
        def __init__(self, pid):
            self.pid = pid

        def oneshot(self):
            return _NullContext()

        def name(self):
            return f"proc-{self.pid}"

        def exe(self):
            return f"/tmp/proc-{self.pid}"

        def cmdline(self):
            return [f"proc-{self.pid}", "--run"]

    fake_psutil = SimpleNamespace(
        CONN_LISTEN="LISTEN",
        net_connections=lambda kind="tcp": connections,
        Process=FakeProcess,
        AccessDenied=RuntimeError,
        ZombieProcess=RuntimeError,
        NoSuchProcess=RuntimeError,
        TimeoutExpired=RuntimeError,
    )
    monkeypatch.setattr(port_diagnostics, "psutil", fake_psutil)

    owners = port_diagnostics.find_port_owners(55001, bind_host="127.0.0.1")
    owner_pids = {owner.pid for owner in owners}
    assert owner_pids == {101, 202}


def test_describe_port_owners_has_pid_and_host():
    owners = [
        port_diagnostics.PortOwner(
            pid=111,
            name="python.exe",
            exe="",
            cmdline="",
            host="127.0.0.1",
            port=55001,
        )
    ]

    text = port_diagnostics.describe_port_owners(owners)
    assert "PID 111" in text
    assert "127.0.0.1:55001" in text
