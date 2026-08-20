from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_text_domain_has_no_asyncio_or_thread_startup_primitives():
    for path in (ROOT / "GameSentenceMiner" / "text_pipeline").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert all(alias.name != "asyncio" for alias in node.names), path
            if isinstance(node, ast.ImportFrom):
                assert node.module != "asyncio", path
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert not (
                    isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "threading"
                    and node.func.attr == "Thread"
                ), path


def test_removed_concurrency_bandaids_cannot_return():
    production = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "GameSentenceMiner").rglob("*.py"))
    assert "class AsyncBackgroundRunner" not in production
    assert "run_new_thread" not in production

    gametext = _source("GameSentenceMiner/gametext.py")
    assert "schedule_merge" not in gametext
    assert "merge_sequential_lines" not in gametext


def test_websocket_server_does_not_start_during_module_import():
    tree = ast.parse(_source("GameSentenceMiner/web/gsm_websocket.py"))
    top_level_calls = [node for node in tree.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)]
    forbidden = {"start", "start_server", "start_multiplex_server"}
    for statement in top_level_calls:
        function = statement.value.func
        if isinstance(function, ast.Attribute):
            assert function.attr not in forbidden
        elif isinstance(function, ast.Name):
            assert function.id not in forbidden
