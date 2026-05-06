from __future__ import annotations

import os
import re
import subprocess
import sys
import time


SUCCESS_PATTERNS = [
    re.compile(r"GSM Loaded", re.IGNORECASE),
    re.compile(r"GSM Ready", re.IGNORECASE),
    re.compile(r"Initialization complete", re.IGNORECASE),
]


def _matches_success(line: str) -> bool:
    return any(pattern.search(line) for pattern in SUCCESS_PATTERNS)


def main() -> int:
    timeout_seconds = int(os.environ.get("GSM_SMOKE_TIMEOUT_SECONDS", "60"))

    cmd = [sys.executable, "-u", "-m", "GameSentenceMiner.gsm"]
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")

    print(f"[gsm-smoke] Starting: {' '.join(cmd)}")
    print(f"[gsm-smoke] Timeout: {timeout_seconds}s")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )

    start = time.time()
    matched = False

    try:
        while True:
            if proc.stdout is None:
                break

            line = proc.stdout.readline()
            if line:
                clean_line = line.rstrip("\n")
                print(clean_line)
                if _matches_success(clean_line):
                    matched = True
                    print("[gsm-smoke] Success pattern detected.")
                    break

            if proc.poll() is not None:
                break

            if (time.time() - start) >= timeout_seconds:
                print(f"[gsm-smoke] Timeout reached ({timeout_seconds}s).")
                break
    finally:
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    if matched:
        return 0

    return_code = proc.poll()
    if return_code is not None:
        print(f"[gsm-smoke] Process exited before success. return_code={return_code}")
    else:
        print("[gsm-smoke] Process stopped without success pattern.")

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
