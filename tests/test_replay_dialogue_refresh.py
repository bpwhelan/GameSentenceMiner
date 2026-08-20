from concurrent.futures import Future
from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner import replay_handler


def test_request_dialogue_replay_refresh_queues_job_before_saving(monkeypatch):
    jobs = []
    save_calls = []
    monkeypatch.setattr(replay_handler.anki, "card_queue", jobs)
    monkeypatch.setattr(replay_handler.obs, "save_replay_buffer", lambda: save_calls.append(True))

    selected_lines = [SimpleNamespace(id="line-1")]
    future = replay_handler.request_dialogue_replay_refresh(
        selected_lines=selected_lines,
        mined_line=selected_lines[0],
        full_text="line one",
        timing_context=None,
    )

    assert isinstance(future, Future)
    assert len(jobs) == 1
    assert isinstance(jobs[0], replay_handler.DialogueReplayRefreshRequest)
    assert jobs[0].selected_lines == selected_lines
    assert save_calls == [True]


def test_process_replay_routes_followup_audio_to_existing_dialog_future(monkeypatch, tmp_path):
    capture_time = datetime.now()
    first_line = SimpleNamespace(id="line-1", text="one", time=capture_time - timedelta(seconds=2))
    second_line = SimpleNamespace(id="line-2", text="two", time=capture_time - timedelta(seconds=1), next=None)
    first_line.next = second_line
    future = Future()
    request = replay_handler.DialogueReplayRefreshRequest(
        selected_lines=[first_line, second_line],
        mined_line=first_line,
        full_text="one two",
        capture_time=capture_time,
        timing_context=None,
        future=future,
    )
    audio_result = SimpleNamespace(final_audio_output="dialogue.opus")
    calls = []
    monkeypatch.setattr(
        replay_handler.ReplayAudioExtractor,
        "get_audio",
        staticmethod(lambda *args, **kwargs: calls.append((args, kwargs)) or audio_result),
    )
    monkeypatch.setattr(
        replay_handler,
        "get_config",
        lambda: SimpleNamespace(paths=SimpleNamespace(remove_video=False)),
    )
    original_context = object()
    monkeypatch.setattr(replay_handler.gsm_state, "current_replay_context", original_context, raising=False)

    replay_handler.ReplayAudioExtractor().process_replay(str(tmp_path / "Replay followup.mp4"), queued_job=request)

    result = future.result(timeout=0)
    assert result.audio_result is audio_result
    assert result.capture_time == capture_time
    assert result.video_path.endswith("Replay followup.mp4")
    assert calls[0][0][0] is first_line
    assert calls[0][0][1] == 0
    assert calls[0][1]["full_text"] == "one two"
    assert replay_handler.gsm_state.current_replay_context is original_context


def test_file_watcher_routes_dialogue_replay_to_concurrent_refresh_lane(tmp_path):
    future = Future()
    request = replay_handler.DialogueReplayRefreshRequest(
        selected_lines=[SimpleNamespace(id="line-1")],
        mined_line=None,
        full_text="line one",
        capture_time=datetime.now(),
        timing_context=None,
        future=future,
    )
    extractor = SimpleNamespace(claim_replay_job=lambda: request)

    class _RecordingExecutor:
        def __init__(self):
            self.calls = []

        def submit(self, callback, *args):
            self.calls.append((callback, args))

    normal_executor = _RecordingExecutor()
    refresh_executor = _RecordingExecutor()
    watcher = replay_handler.ReplayFileWatcher(
        extractor,
        executor=normal_executor,
        refresh_executor=refresh_executor,
    )

    watcher.on_created(SimpleNamespace(is_directory=False, src_path=str(tmp_path / "Replay followup.mp4")))

    assert normal_executor.calls == []
    assert len(refresh_executor.calls) == 1
    assert refresh_executor.calls[0][1][1] is request
