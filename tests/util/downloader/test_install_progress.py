from GameSentenceMiner.util.downloader import download_tools


class _FakeResponse:
    def __init__(self, chunks, total_bytes):
        self._chunks = chunks
        self.headers = {"Content-Length": str(total_bytes)}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size=8192):
        yield from self._chunks


def test_download_file_reports_byte_progress(monkeypatch, tmp_path):
    progress_events = []
    monkeypatch.setattr(
        download_tools.requests,
        "get",
        lambda *args, **kwargs: _FakeResponse([b"ab", b"cd"], total_bytes=4),
    )
    monkeypatch.setattr(
        download_tools,
        "report_install_progress",
        lambda *args, **kwargs: progress_events.append(kwargs),
    )

    destination = tmp_path / "ffmpeg.zip"

    result = download_tools.download_file(
        "https://example.invalid/ffmpeg.zip",
        str(destination),
        chunk_size=2,
        stage_id="ffmpeg",
        message="Downloading FFmpeg...",
    )

    assert result is True
    assert destination.read_bytes() == b"abcd"
    assert progress_events == [
        {
            "status": "running",
            "progress_kind": "bytes",
            "progress": 0.5,
            "message": "Downloading FFmpeg...",
            "downloaded_bytes": 2,
            "total_bytes": 4,
        },
        {
            "status": "running",
            "progress_kind": "bytes",
            "progress": 1.0,
            "message": "Downloading FFmpeg...",
            "downloaded_bytes": 4,
            "total_bytes": 4,
        },
    ]


def test_download_obs_if_needed_returns_skipped_for_existing_install(monkeypatch, tmp_path):
    app_dir = tmp_path / "app"
    obs_dir = app_dir / "obs-studio"
    plugin_path = obs_dir / "obs-plugins" / "64bit" / "advanced-scene-switcher.dll"
    obs_exe = obs_dir / "bin" / "64bit" / "obs64.exe"

    plugin_path.parent.mkdir(parents=True, exist_ok=True)
    obs_exe.parent.mkdir(parents=True, exist_ok=True)
    plugin_path.write_bytes(b"dll")
    obs_exe.write_bytes(b"exe")

    monkeypatch.setattr(download_tools, "get_app_directory", lambda: str(app_dir))
    monkeypatch.setattr(download_tools, "get_obs_path", lambda: str(obs_exe))

    assert download_tools.download_obs_if_needed(stage_id="obs") == "skipped"
