import asyncio
import os
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

import GameSentenceMiner.gsm as gsm_module
import GameSentenceMiner.obs as obs_module
import GameSentenceMiner.obs.service as obs_service
from GameSentenceMiner.util import media_paths
from GameSentenceMiner.util.config import configuration


@pytest.fixture
def media_config(monkeypatch, tmp_path):
    paths = SimpleNamespace(
        folder_to_watch=str(tmp_path / "Naicha" / "Videos" / "GSM"),
        output_folder=str(tmp_path / "Naicha" / "Videos" / "GSM" / "Output"),
    )
    config = SimpleNamespace(paths=paths)
    other_profile = SimpleNamespace(paths=SimpleNamespace(**vars(paths)))
    saved = []

    def sync_shared_fields():
        other_profile.paths = SimpleNamespace(**vars(paths))

    master = SimpleNamespace(sync_shared_fields=sync_shared_fields)
    monkeypatch.setattr(configuration, "get_config", lambda: config)
    monkeypatch.setattr(configuration, "get_master_config", lambda: master)
    monkeypatch.setattr(configuration, "get_app_directory", lambda: str(tmp_path / "GSM_Data"))
    monkeypatch.setattr(configuration, "save_full_config", lambda _master: saved.append(dict(vars(paths))))
    monkeypatch.setattr(gsm_module, "get_config", lambda: config)
    monkeypatch.setattr(obs_service, "get_config", lambda: config)
    monkeypatch.setattr(gsm_module.gsm_status, "obs_connected", False)
    return SimpleNamespace(
        config=config,
        other_profile=other_profile,
        saved=saved,
        fallback=tmp_path / "GSM_Data" / "recordings",
    )


def make_watcher_app(monkeypatch):
    watched = []

    class Observer:
        def schedule(self, handler, path, recursive):
            watched.append((path, recursive))

        def start(self):
            pass

        def stop(self):
            pass

        def join(self, timeout):
            pass

    monkeypatch.setattr(gsm_module, "Observer", Observer)
    monkeypatch.setattr(
        gsm_module,
        "_get_replay_handler_module",
        lambda: SimpleNamespace(ReplayFileWatcher=lambda _extractor: object()),
    )
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    app.state = SimpleNamespace(file_watcher_observer=None, file_watcher_path=None)
    app._replay_extractor = object()
    return app, watched


def fail_directory_creation(monkeypatch, directory, error):
    original_makedirs = os.makedirs

    def makedirs(path, *args, **kwargs):
        if os.path.normpath(path) == os.path.normpath(directory):
            raise error
        return original_makedirs(path, *args, **kwargs)

    monkeypatch.setattr(os, "makedirs", makedirs)


def test_watcher_creates_missing_but_usable_recording_directory(monkeypatch, media_config):
    app, watched = make_watcher_app(monkeypatch)
    requested = media_config.config.paths.folder_to_watch

    app.start_file_watcher()

    assert Path(requested).is_dir()
    assert watched == [(requested, False)]
    assert not media_config.saved
    assert not media_config.fallback.exists()


@pytest.mark.parametrize("error", [FileNotFoundError("[WinError 2]"), PermissionError("Access denied")])
def test_watcher_recovers_from_unusable_recording_directory(monkeypatch, media_config, error):
    app, watched = make_watcher_app(monkeypatch)
    fail_directory_creation(monkeypatch, media_config.config.paths.folder_to_watch, error)

    app.start_file_watcher()

    assert watched == [(str(media_config.fallback), False)]
    assert app.state.file_watcher_path == str(media_config.fallback)
    assert media_config.config.paths.folder_to_watch == str(media_config.fallback)
    assert media_config.other_profile.paths.folder_to_watch == str(media_config.fallback)
    assert media_config.saved[-1]["folder_to_watch"] == str(media_config.fallback)
    assert media_config.fallback.is_dir()
    assert list(media_config.fallback.iterdir()) == []


def test_watcher_checks_writability_even_when_directory_exists(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    Path(requested).mkdir(parents=True)
    original_temporary_file = tempfile.NamedTemporaryFile

    def temporary_file(*args, **kwargs):
        if os.path.normpath(kwargs.get("dir", "")) == os.path.normpath(requested):
            raise PermissionError("Cannot write recording files")
        return original_temporary_file(*args, **kwargs)

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", temporary_file)
    app, watched = make_watcher_app(monkeypatch)

    app.start_file_watcher()

    assert watched == [(str(media_config.fallback), False)]


class RecordingClient:
    def __init__(self, directory):
        self.directory = directory
        self.changes = []
        self.replay_active = False
        self.replay_events = []

    def get_record_directory(self):
        return SimpleNamespace(record_directory=self.directory)

    def set_record_directory(self, directory):
        self.changes.append(directory)
        self.directory = directory

    def get_replay_buffer_status(self):
        return SimpleNamespace(output_active=self.replay_active)

    def stop_replay_buffer(self):
        self.replay_events.append("stop")
        self.replay_active = False

    def start_replay_buffer(self):
        self.replay_events.append(("start", self.directory))
        self.replay_active = True


def connect_client(monkeypatch, client):
    async def connected():
        return True

    monkeypatch.setattr(obs_service, "wait_for_obs_connected", connected)
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(
        obs_module,
        "connection_pool",
        SimpleNamespace(call=lambda operation, **kwargs: operation(client)),
    )


@pytest.mark.parametrize("watcher_started_first", [False, True])
def test_obs_unusable_directory_moves_obs_and_gsm_to_same_fallback(monkeypatch, media_config, watcher_started_first):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(requested)
    connect_client(monkeypatch, client)
    if watcher_started_first:
        app, _watched = make_watcher_app(monkeypatch)
        app.start_file_watcher()

    asyncio.run(obs_service.check_obs_folder_is_correct())

    assert client.changes == [media_config.fallback.as_posix()]
    assert Path(client.directory) == media_config.fallback
    assert Path(media_config.config.paths.folder_to_watch) == media_config.fallback
    assert Path(media_config.saved[-1]["folder_to_watch"]) == media_config.fallback
    if watcher_started_first:
        assert Path(app.state.file_watcher_path) == media_config.fallback


def test_obs_valid_custom_directory_is_preserved(monkeypatch, media_config, tmp_path):
    client = RecordingClient(str(tmp_path / "Custom recordings"))
    connect_client(monkeypatch, client)

    asyncio.run(obs_service.check_obs_folder_is_correct())

    assert client.changes == []
    assert media_config.config.paths.folder_to_watch == client.directory
    assert Path(client.directory).is_dir()
    assert not media_config.fallback.exists()


def test_obs_rejected_fallback_does_not_save_unusable_obs_path(monkeypatch, media_config, tmp_path):
    invalid_obs_path = str(tmp_path / "Unavailable OBS recordings")
    fail_directory_creation(monkeypatch, invalid_obs_path, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(invalid_obs_path)
    connect_client(monkeypatch, client)
    original_gsm_path = media_config.config.paths.folder_to_watch

    def reject_change(directory):
        raise RuntimeError("OBS recording is active")

    monkeypatch.setattr(client, "set_record_directory", reject_change)

    asyncio.run(obs_service.check_obs_folder_is_correct())

    assert media_config.config.paths.folder_to_watch == original_gsm_path
    assert media_config.saved == []


def test_obs_restarts_active_replay_buffer_to_apply_fallback(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(requested)
    client.replay_active = True
    connect_client(monkeypatch, client)

    assert asyncio.run(obs_service.check_obs_folder_is_correct()) is True

    assert client.replay_events == ["stop", ("start", media_config.fallback.as_posix())]
    assert client.replay_active


def test_obs_rejects_unchanged_directory_after_update(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(requested)
    monkeypatch.setattr(client, "set_record_directory", lambda directory: None)
    connect_client(monkeypatch, client)

    assert asyncio.run(obs_service.check_obs_folder_is_correct()) is False

    assert media_config.config.paths.folder_to_watch == requested
    assert not media_config.saved


@pytest.mark.parametrize("check_output", [False, True])
def test_obs_prepares_directory_before_initializing_outputs(monkeypatch, media_config, check_output):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(requested)
    client.get_current_program_scene = lambda: SimpleNamespace(scene_name="")
    client.get_output_list = lambda: SimpleNamespace(outputs=[])
    service = obs_service.OBSService.__new__(obs_service.OBSService)
    service.check_output = check_output
    service.initialized = False
    service._state_lock = threading.Lock()
    service.state = obs_service.OBSState()
    service._recording_directory_handlers = []
    service.connection_pool = SimpleNamespace(call=lambda operation, **kwargs: operation(client))
    service._refresh_scene_items = lambda *args, **kwargs: None
    service._update_output_cache = lambda outputs: None
    checked_directories = []
    service._refresh_replay_buffer_settings = lambda client: checked_directories.append(client.directory)

    service._initialize_state()

    assert service.initialized
    assert checked_directories == ([media_config.fallback.as_posix()] if check_output else [])
    assert client.changes == ([media_config.fallback.as_posix()] if check_output else [])


def test_running_watcher_follows_obs_folder_recovery(monkeypatch, media_config, tmp_path):
    app, watched = make_watcher_app(monkeypatch)
    app.start_file_watcher()
    original_gsm_path = media_config.config.paths.folder_to_watch
    invalid_obs_path = str(tmp_path / "unavailable-drive" / "recordings")
    fail_directory_creation(monkeypatch, invalid_obs_path, FileNotFoundError("[WinError 2]"))
    client = RecordingClient(invalid_obs_path)
    connect_client(monkeypatch, client)
    service = obs_service.OBSService.__new__(obs_service.OBSService)
    service._recording_directory_handlers = []
    monkeypatch.setattr(obs_module, "obs_service", service)
    monkeypatch.setattr(gsm_module.gsm_status, "obs_connected", True)
    app._register_recording_directory_watcher()
    app._register_recording_directory_watcher()

    assert asyncio.run(obs_service.check_obs_folder_is_correct()) is True

    assert watched == [(original_gsm_path, False), (str(media_config.fallback), False)]
    assert Path(app.state.file_watcher_path) == Path(client.directory)


def test_output_directory_recovers_independently_of_recording_directory(monkeypatch, media_config):
    original_recording = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, media_config.config.paths.output_folder, PermissionError("Access denied"))

    directory = media_paths.ensure_output_directory()

    assert Path(directory) == media_config.fallback.parent / "output"
    assert Path(directory).is_dir()
    assert media_config.config.paths.folder_to_watch == original_recording
    assert media_config.saved[-1]["output_folder"] == directory


def test_recording_fallback_preserves_files_across_temp_cleanup(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    directory = Path(media_paths.ensure_recording_directory())
    recording = directory / "unfinished-recording.mkv"
    recording.write_bytes(b"recording")
    monkeypatch.setattr(configuration, "temp_directory", "")
    temporary = Path(configuration.get_temporary_directory()) / "stale.tmp"
    temporary.write_bytes(b"temporary")

    configuration.get_temporary_directory(delete=True)

    assert not temporary.exists()
    assert recording.read_bytes() == b"recording"


@pytest.mark.parametrize("invalid_path", ["", "contains\x00null"])
def test_empty_or_invalid_recording_path_uses_fallback(media_config, invalid_path):
    media_config.config.paths.folder_to_watch = invalid_path

    assert Path(media_paths.ensure_recording_directory()) == media_config.fallback


def test_file_in_place_of_recording_directory_uses_fallback(media_config, tmp_path):
    file_path = tmp_path / "not-a-directory"
    file_path.write_bytes(b"keep this file")
    media_config.config.paths.folder_to_watch = str(file_path)

    assert Path(media_paths.ensure_recording_directory()) == media_config.fallback
    assert file_path.read_bytes() == b"keep this file"


def test_unusable_fallback_reports_both_paths_without_saving(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))
    fail_directory_creation(monkeypatch, str(media_config.fallback), PermissionError("Access denied"))

    with pytest.raises(OSError, match="Choose a writable folder") as error:
        media_paths.ensure_recording_directory()

    assert repr(requested) in str(error.value)
    assert repr(str(media_config.fallback)) in str(error.value)
    assert media_config.config.paths.folder_to_watch == requested
    assert not media_config.saved


def test_readonly_config_does_not_prevent_using_fallback(monkeypatch, media_config):
    requested = media_config.config.paths.folder_to_watch
    fail_directory_creation(monkeypatch, requested, FileNotFoundError("[WinError 2]"))

    def fail_save(_master):
        raise PermissionError("config.json is read-only")

    monkeypatch.setattr(configuration, "save_full_config", fail_save)

    assert Path(media_paths.ensure_recording_directory()) == media_config.fallback
    assert Path(media_config.config.paths.folder_to_watch) == media_config.fallback
