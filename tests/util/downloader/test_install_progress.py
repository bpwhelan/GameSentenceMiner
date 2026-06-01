import os
import zipfile

import pytest

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


def test_install_scene_switcher_remaps_release_layout_to_obs_portable(tmp_path):
    # The release zip ships <root>/bin/64bit/* and <root>/data/*; OBS portable needs
    # the plugin under obs-plugins/64bit and its data under data/obs-plugins/<name>.
    extract_dir = tmp_path / "extracted"
    plugin_root = extract_dir / "advanced-scene-switcher"
    bin_64bit = plugin_root / "bin" / "64bit"
    data_dir = plugin_root / "data" / "locale"
    bin_64bit.mkdir(parents=True)
    data_dir.mkdir(parents=True)
    (bin_64bit / "advanced-scene-switcher.dll").write_bytes(b"dll")
    (bin_64bit / "advanced-scene-switcher-plugins").mkdir()
    (bin_64bit / "advanced-scene-switcher-plugins" / "base.dll").write_bytes(b"base")
    (data_dir / "en-US.ini").write_bytes(b"locale")

    obs_path = tmp_path / "obs-studio"

    download_tools.install_scene_switcher_from_extracted(str(extract_dir), str(obs_path))

    assert (obs_path / "obs-plugins" / "64bit" / "advanced-scene-switcher.dll").exists()
    assert (obs_path / "obs-plugins" / "64bit" / "advanced-scene-switcher-plugins" / "base.dll").exists()
    assert (obs_path / "data" / "obs-plugins" / "advanced-scene-switcher" / "locale" / "en-US.ini").exists()
    # The detection path used to skip future downloads must now resolve.
    assert os.path.exists(download_tools.get_scene_switcher_dll_path(str(obs_path)))


def test_ffmpeg_download_spec_uses_full_shared_build_for_windows_x64(monkeypatch):
    monkeypatch.setattr(download_tools.platform, "system", lambda: "Windows")
    monkeypatch.setattr(download_tools.platform, "machine", lambda: "AMD64")

    spec = download_tools.get_ffmpeg_download_spec()

    assert spec["version"] == "8.1.1"
    assert spec["build"] == "full_build_shared"
    assert (
        spec["url"] == "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build-shared.zip"
    )


def test_parse_ffmpeg_version_output_detects_full_shared_build():
    version, build = download_tools.parse_ffmpeg_version_output(
        "ffmpeg version 8.1.1-full_build-www.gyan.dev\nconfiguration: --enable-shared --enable-gpl"
    )

    assert version == "8.1.1"
    assert build == "full_build_shared"


def test_download_ffmpeg_upgrades_outdated_existing_install_without_removing_it_on_download_failure(
    monkeypatch, tmp_path
):
    app_dir = tmp_path / "app"
    ffmpeg_dir = app_dir / "ffmpeg"
    ffmpeg_exe = ffmpeg_dir / "ffmpeg.exe"
    ffprobe_exe = ffmpeg_dir / "ffprobe.exe"
    ffmpeg_dir.mkdir(parents=True)
    ffmpeg_exe.write_bytes(b"old ffmpeg")
    ffprobe_exe.write_bytes(b"old ffprobe")

    monkeypatch.setattr(download_tools, "get_app_directory", lambda: str(app_dir))
    monkeypatch.setattr(download_tools, "get_ffmpeg_path", lambda: str(ffmpeg_exe))
    monkeypatch.setattr(download_tools, "get_ffprobe_path", lambda: str(ffprobe_exe))
    monkeypatch.setattr(download_tools.platform, "system", lambda: "Windows")
    monkeypatch.setattr(download_tools.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(
        download_tools,
        "get_installed_ffmpeg_info",
        lambda _ffmpeg_exe_path: ("8.0.1", "essentials_build"),
        raising=False,
    )

    download_calls = []

    def fake_download_file(url, dest_path, **kwargs):
        download_calls.append((url, dest_path, kwargs))
        return False

    monkeypatch.setattr(download_tools, "download_file", fake_download_file)

    with pytest.raises(RuntimeError, match="Failed to download FFmpeg"):
        download_tools.download_ffmpeg_if_needed(stage_id="ffmpeg")

    assert download_calls[0][0] == (
        "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build-shared.zip"
    )
    assert ffmpeg_exe.read_bytes() == b"old ffmpeg"
    assert ffprobe_exe.read_bytes() == b"old ffprobe"


def test_download_ffmpeg_installs_full_shared_build_zip_and_prunes_extra_files(monkeypatch, tmp_path):
    app_dir = tmp_path / "app"
    ffmpeg_dir = app_dir / "ffmpeg"
    ffmpeg_exe = ffmpeg_dir / "ffmpeg.exe"
    ffprobe_exe = ffmpeg_dir / "ffprobe.exe"

    monkeypatch.setattr(download_tools, "get_app_directory", lambda: str(app_dir))
    monkeypatch.setattr(download_tools, "get_ffmpeg_path", lambda: str(ffmpeg_exe))
    monkeypatch.setattr(download_tools, "get_ffprobe_path", lambda: str(ffprobe_exe))
    monkeypatch.setattr(download_tools.platform, "system", lambda: "Windows")
    monkeypatch.setattr(download_tools.platform, "machine", lambda: "AMD64")

    def fake_download_file(_url, dest_path, **_kwargs):
        with zipfile.ZipFile(dest_path, "w") as zip_file:
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/bin/ffmpeg.exe", b"new ffmpeg")
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/bin/ffprobe.exe", b"new ffprobe")
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/bin/avcodec-62.dll", b"dll")
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/bin/ffplay.exe", b"ffplay")
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/doc/readme.txt", b"docs")
            zip_file.writestr("ffmpeg-8.1.1-full_build-shared/LICENSE", b"license")
        return True

    monkeypatch.setattr(download_tools, "download_file", fake_download_file)

    assert download_tools.download_ffmpeg_if_needed(stage_id="ffmpeg") == "completed"
    assert ffmpeg_exe.read_bytes() == b"new ffmpeg"
    assert ffprobe_exe.read_bytes() == b"new ffprobe"

    assert sorted(path.name for path in ffmpeg_dir.iterdir()) == ["avcodec-62.dll", "ffmpeg.exe", "ffprobe.exe"]


def test_download_ffmpeg_prunes_extra_files_when_existing_install_is_current(monkeypatch, tmp_path):
    app_dir = tmp_path / "app"
    ffmpeg_dir = app_dir / "ffmpeg"
    ffmpeg_exe = ffmpeg_dir / "ffmpeg.exe"
    ffprobe_exe = ffmpeg_dir / "ffprobe.exe"
    docs_file = ffmpeg_dir / "doc" / "readme.txt"
    ffmpeg_dir.mkdir(parents=True)
    ffmpeg_exe.write_bytes(b"ffmpeg")
    ffprobe_exe.write_bytes(b"ffprobe")
    (ffmpeg_dir / "avcodec-62.dll").write_bytes(b"dll")
    (ffmpeg_dir / "ffplay.exe").write_bytes(b"ffplay")
    docs_file.parent.mkdir()
    docs_file.write_bytes(b"docs")

    monkeypatch.setattr(download_tools, "get_app_directory", lambda: str(app_dir))
    monkeypatch.setattr(download_tools, "get_ffmpeg_path", lambda: str(ffmpeg_exe))
    monkeypatch.setattr(download_tools, "get_ffprobe_path", lambda: str(ffprobe_exe))
    monkeypatch.setattr(download_tools.platform, "system", lambda: "Windows")
    monkeypatch.setattr(download_tools.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(
        download_tools,
        "get_installed_ffmpeg_info",
        lambda _ffmpeg_exe_path: ("8.1.1", "full_build_shared"),
    )

    assert download_tools.download_ffmpeg_if_needed(stage_id="ffmpeg") == "skipped"
    assert sorted(path.name for path in ffmpeg_dir.iterdir()) == ["avcodec-62.dll", "ffmpeg.exe", "ffprobe.exe"]
