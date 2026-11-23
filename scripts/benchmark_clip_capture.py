"""Verify real multi-stream saved clips, compare both writers and optionally exercise desktop capture."""

import argparse
import datetime
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

from benchmark_stats import (
    REPO_ROOT,
    _configure_bootstrap_environment,
    _install_keyboard_stub,
    _install_noop_logging_module,
)
from benchmark_stats_web import measure, start_worker


def reference(root):
    _configure_bootstrap_environment(root / "bootstrap")
    _install_keyboard_stub()
    _install_noop_logging_module()
    from GameSentenceMiner.util import clips
    from GameSentenceMiner.util.media import ffmpeg

    exe = ".exe" if os.name == "nt" else ""
    ffmpeg.ffmpeg_base_command_list[0] = str(root / "ffmpeg" / ("ffmpeg" + exe))
    ffmpeg.get_ffprobe_path = lambda: str(root / "ffmpeg" / ("ffprobe" + exe))
    replay = root / "source.mkv"
    end = replay.stat().st_mtime
    clips.pause_history.remember_pauses([(end - 6, end - 5.75)])
    lines = []
    for i in range(5):
        row = SimpleNamespace(
            id=f"line-{i}",
            text=f"台詞{i}",
            time=datetime.datetime.fromtimestamp(end - 9.5 + i * 1.5, datetime.UTC).astimezone().replace(tzinfo=None),
            first_seen_time=None,
            prev=lines[-1] if lines else None,
            next=None,
            scene="ゲーム",
            source="manual",
            source_padding=0,
        )
        if lines:
            lines[-1].next = row
        lines.append(row)
    seq = 0
    print(f"ready {os.getpid()}", flush=True)
    for command in sys.stdin:
        operation, count, verify_output = json.loads(command)
        if operation == "trim":
            from GameSentenceMiner.web import service

            service.get_config().paths.output_folder = str(root / "exports-python")
        elif operation == "audio":
            from GameSentenceMiner.replay_handler import ReplayAudioExtractor
        elif operation == "folder":
            from GameSentenceMiner.replay_handler import ReplayAudioExtractor
            from GameSentenceMiner.web import service

            service.set_get_audio_from_video_callback(ReplayAudioExtractor.get_audio)
            service.get_config().screenshot.enabled = False
            service.get_config().paths.copy_trimmed_replay_to_output_folder = True
            lines[3].get_next_time = lambda: lines[4].time
        elif operation == "frames":
            from GameSentenceMiner.ui import screenshot_selector_qt as selector
            from GameSentenceMiner.util.media.screenshot_selection import ScreenshotChoice, export_choices

            selector.get_ffprobe_path = ffmpeg.get_ffprobe_path
            settings = ffmpeg.get_config().screenshot
            settings.width, settings.height, settings.extension, settings.trim_black_bars_wip = 160, 0, "jpg", False
        start = time.perf_counter()
        for _ in range(count):
            seq += 1
            source = root / f"replay-python-{seq}.mkv"
            os.link(replay, source)
            if operation == "frames":
                worker = selector.FrameWorker(1, str(source))
                try:
                    worker._probe()
                    # The first full page around 6.125 seconds, including the reference at index 12.
                    frames = worker._extract_page([0.125 + i * 0.5 for i in range(25)], 0)
                    choices = tuple(ScreenshotChoice(*frames[i]) for i in (12, 2))
                    result = export_choices(str(source), choices, worker.duration)
                    path = str(root / "frames-python.json")
                    if verify_output:
                        Path(path).write_text(
                            json.dumps(
                                {
                                    "frames": [(p, t) for t, p in frames],
                                    "exported": [(f.path, f.start) for f in result.items],
                                }
                            ),
                            encoding="utf8",
                        )
                    else:
                        for f in result.items:
                            Path(f.path).unlink()
                finally:
                    if not verify_output:
                        shutil.rmtree(worker.directory)
            elif operation == "folder":
                target = root / f"folder-python-{seq}"
                service.get_config().paths.output_folder = str(target)
                pending = SimpleNamespace(
                    lines_for_media_creation=lines[2:4], media_creation_request={"open_folder": False}
                )
                service.create_media_for_lines(str(source), pending)
                path = str(next(target.rglob("sentence.txt")).parent)
            elif operation == "trim":
                trimmed = service._trim_video_for_line(lines[2], str(source), False)
                path = service._save_texthooker_video_clip(trimmed, lines[2])
            elif operation == "audio":
                path = ReplayAudioExtractor.get_audio(
                    lines[2], lines[3].time, str(source), temporary=True, use_vad_postprocessing=False
                )
            else:
                path = clips.save_clip(str(source), lines[2], str(root / f"python-{seq}"))
        print(json.dumps({"ms": (time.perf_counter() - start) * 1000 / count, "folder": path}), flush=True)


def verify(root, folder):
    manifest = json.loads((folder / "manifest.json").read_bytes())
    for line in manifest["lines"]:
        line["time"] = datetime.datetime.fromisoformat(line["time"]).isoformat(timespec="microseconds")
    end = datetime.datetime.fromisoformat(manifest["clip"]["end_time"])
    manifest["clip"]["end_time"] = end.isoformat(timespec="microseconds")
    video = folder / manifest["clip"]["file"]
    assert abs(video.stat().st_mtime - end.timestamp()) < 0.00001
    probe = probe_packets(root, video)
    assert [s["codec_type"] for s in probe["streams"]] == ["video", "audio", "audio"]
    assert [l["role"] for l in manifest["lines"]].count("selected") == 1 and len(manifest["pauses"]) == 1
    return manifest, hashlib.sha256(json.dumps(probe, sort_keys=True).encode()).hexdigest()


def probe_packets(root, video):
    packet_data = subprocess.check_output(
        [
            str(root / "ffmpeg" / ("ffprobe.exe" if os.name == "nt" else "ffprobe")),
            "-v",
            "error",
            "-show_packets",
            "-show_streams",
            "-show_data_hash",
            "sha256",
            "-show_entries",
            "packet=stream_index,pts_time,duration_time,data_hash:stream=index,codec_name,codec_type",
            "-of",
            "json",
            str(video),
        ]
    )
    return json.loads(packet_data)


def verify_trim(root, output):
    assert output.is_file() and "台詞2" in output.name and output.suffix == ".mp4", output
    data = probe_packets(root, output)
    assert [s["codec_name"] for s in data["streams"]] == ["h264", "aac"]
    assert data["packets"] and float(data["packets"][-1]["pts_time"]) > 0
    return {"streams": [s["codec_name"] for s in data["streams"]], "packets": len(data["packets"])}, hashlib.sha256(
        json.dumps(data, sort_keys=True).encode()
    ).hexdigest()


def tree_accounting(stack, worker):
    if os.name != "nt":
        return None
    import win32api
    import win32con
    import win32job

    job = win32job.CreateJobObject(None, str(uuid.uuid4()))
    stack.callback(job.Close)
    proc = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, worker[1].pid)
    try:
        win32job.AssignProcessToJobObject(job, proc)
    finally:
        proc.Close()

    def read():
        info = win32job.QueryInformationJobObject(job, win32job.JobObjectBasicAccountingInformation)
        peak = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)["PeakJobMemoryUsed"]
        return (info["TotalUserTime"] + info["TotalKernelTime"]) / 10000, peak / (1024**2)

    return read


def verify_audio(root, output):
    import wave

    with wave.open(str(output), "rb") as file:
        metadata = {"channels": file.getnchannels(), "sample_rate": file.getframerate(), "frames": file.getnframes()}
        assert metadata["frames"] > 0 and metadata["sample_rate"] == 44100, metadata
        return metadata, hashlib.sha256(file.readframes(file.getnframes())).hexdigest()


def verify_frames(root, output):
    frames = json.loads(output.read_bytes())
    assert len(frames["frames"]) == 25 and [t for _, t in frames["exported"]] == [6.125, 1.125]
    digests = {
        k: [(t, hashlib.sha256(Path(p).read_bytes()).hexdigest()) for p, t in rows] for k, rows in frames.items()
    }
    return {"preview_count": 25, "exported_seconds": [6.125, 1.125]}, hashlib.sha256(
        json.dumps(digests, sort_keys=True).encode()
    ).hexdigest()


def verify_folder(root, output):
    text = (output / "sentence.txt").read_text(encoding="utf8")
    assert text == "台詞2台詞3"
    audio, pcm = verify_audio(root, next(output.glob("*.wav")))
    video = probe_packets(root, next(output.glob("*.mp4")))
    digest = hashlib.sha256(json.dumps([pcm, video], sort_keys=True).encode()).hexdigest()
    return {"text": text, "audio": audio, "video_packets": len(video["packets"])}, digest


def run(root, rounds, operation):
    exe = REPO_ROOT / "src-tauri/target/native-dev/release/examples/clip_capture_benchmark"
    if os.name == "nt":
        exe = exe.with_suffix(".exe")
    samples = {"python": [], "rust": []}
    with ExitStack() as stack:
        workers = {
            "python": start_worker(stack, [sys.executable, __file__, "--reference", str(root)]),
            "rust": start_worker(stack, [str(exe), str(root)]),
        }
        trees = {k: tree_accounting(stack, w) for k, w in workers.items()}
        check_output = {
            "trim": verify_trim,
            "audio": verify_audio,
            "save": verify,
            "frames": verify_frames,
            "folder": verify_folder,
        }[operation]
        check = [check_output(root, Path(measure(w, operation, 1, verify=True)["folder"])) for w in workers.values()]
        assert check[0] == check[1], check
        for i in range(rounds):
            for k in workers if i % 2 == 0 else reversed(workers):
                before = trees[k]()[0] if trees[k] else None
                row = measure(workers[k], operation, 2)
                row.pop("folder")
                if before is not None:
                    cpu, peak = trees[k]()
                    row.update(tree_cpu_ms=(cpu - before) / 2, peak_tree_commit_mib=peak)
                samples[k].append(row)
    summary = {
        lang: {key: round(statistics.median(r[key] for r in rows), 4) for key in rows[0]}
        for lang, rows in samples.items()
    }
    print(summary, flush=True)
    return {
        "platform": platform.platform(),
        "rounds": rounds,
        "calls_per_round": 2,
        "worker_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "ffmpeg_version": subprocess.check_output(
            [str(root / "ffmpeg" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")), "-version"],
            text=True,
            encoding="utf8",
        ).splitlines()[0],
        "summary": summary,
        "samples": samples,
        {"trim": "trim", "audio": "audio", "save": "manifest", "frames": "screenshots", "folder": "folder"}[
            operation
        ]: check[0][0],
        {"audio": "pcm_sha256", "frames": "images_sha256", "folder": "media_sha256"}.get(
            operation, "packet_stream_sha256"
        ): check[0][1],
    }


def desktop(root):
    from benchmark_obs_outputs import ObsFixture
    from websockets.sync.server import serve

    class Fixture(ObsFixture):
        def write_replay(self):
            replay = self.directory / f"mock-obs-{self.saves}.mkv"
            shutil.copy2(self.directory / "source.mkv", replay)
            return replay

    fixture = Fixture(root)
    fixture.replay = True
    with serve(fixture.handle, "127.0.0.1", 0) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = {
                **os.environ,
                "GSM_SMOKE_FFMPEG_DIR": str((root / "ffmpeg").resolve()),
                "GSM_SMOKE_OBS_PORT": str(server.socket.getsockname()[1]),
                "GSM_SMOKE_CLIP_END": str(int((root / "source.mkv").stat().st_mtime)),
            }
            subprocess.run(
                ["node", "scripts/test-native-desktop.mjs", "clip-capture"], cwd=REPO_ROOT, env=env, check=True
            )
            assert fixture.saves == 3, fixture.saves
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--ffmpeg-dir", type=Path)
    parser.add_argument("--desktop", action="store_true")
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--trim", action="store_true", help="Compare line-aligned MP4 exports")
    operation.add_argument("--audio", action="store_true", help="Compare playable audio extraction and PCM samples")
    operation.add_argument("--frames", action="store_true", help="Compare screenshot pages and multi-image export")
    operation.add_argument("--folder", action="store_true", help="Compare two-line media folder exports")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        reference(args.reference)
    else:
        bindir = args.ffmpeg_dir or (
            Path(os.environ["APPDATA"]) / "GameSentenceMiner/ffmpeg"
            if os.name == "nt"
            else Path(shutil.which("ffmpeg")).parent
        )
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            if os.name == "nt":
                # Use the configured release and its companion DLLs.
                subprocess.run(
                    [
                        "node",
                        "--input-type=module",
                        "-e",
                        "import fs from 'node:fs';fs.symlinkSync(process.argv[1], process.argv[2], 'junction')",
                        str(bindir.resolve()),
                        str(root / "ffmpeg"),
                    ],
                    check=True,
                )
            else:
                (root / "ffmpeg").symlink_to(bindir.resolve(), target_is_directory=True)
            subprocess.run(
                [
                    str(bindir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")),
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=12",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880",
                    "-t",
                    "16",
                    "-map",
                    "0:v",
                    "-map",
                    "1:a",
                    *([] if args.audio or args.folder else ["-map", "2:a"]),
                    "-c:v",
                    "mpeg4",
                    "-g",
                    "24",
                    "-c:a",
                    "aac",
                    str(root / "source.mkv"),
                ],
                check=True,
            )
            end = int(time.time())
            os.utime(root / "source.mkv", (end, end))
            result = run(
                root,
                args.rounds,
                "folder"
                if args.folder
                else "frames"
                if args.frames
                else "audio"
                if args.audio
                else "trim"
                if args.trim
                else "save",
            )
            if args.output:
                args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
            if args.desktop:
                desktop(root)
