import os
import runpy
from pathlib import Path

import pytest


PACKAGE_INIT = Path(__file__).parents[1] / "GameSentenceMiner" / "__init__.py"


@pytest.mark.skipif(os.name != "nt", reason="OpenBLAS reservation cap is Windows-specific")
def test_package_bootstrap_limits_openblas_threads_by_default(monkeypatch):
    monkeypatch.delenv("OPENBLAS_NUM_THREADS", raising=False)

    runpy.run_path(str(PACKAGE_INIT))

    assert os.environ["OPENBLAS_NUM_THREADS"] == "1"


def test_package_bootstrap_preserves_openblas_thread_override(monkeypatch):
    monkeypatch.setenv("OPENBLAS_NUM_THREADS", "4")

    runpy.run_path(str(PACKAGE_INIT))

    assert os.environ["OPENBLAS_NUM_THREADS"] == "4"
