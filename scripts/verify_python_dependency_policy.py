#!/usr/bin/env python3
"""Fail when GSM's Python installers drift away from the authoritative uv lock."""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _rust_string_constant(source: str, name: str) -> str | None:
    match = re.search(rf'\bconst\s+{re.escape(name)}:\s*&str\s*=\s*"([^"]+)"', source)
    return match.group(1) if match else None


def _sync_commands_without_frozen(source: str) -> list[str]:
    commands: list[str] = []
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if "uv sync" in line and "--frozen" not in line:
            commands.append(line)
    return commands


def get_policy_violations() -> list[str]:
    violations: list[str] = []
    pyproject = tomllib.loads(_read("pyproject.toml"))
    lock = tomllib.loads(_read("uv.lock"))

    locked_uv_versions = {package.get("version") for package in lock.get("package", []) if package.get("name") == "uv"}
    if len(locked_uv_versions) != 1:
        violations.append(f"uv.lock must contain exactly one uv version; found {sorted(locked_uv_versions)}")
        locked_uv_version = None
    else:
        locked_uv_version = next(iter(locked_uv_versions))

    project_dependencies = pyproject.get("project", {}).get("dependencies", [])
    uv_requirements = [
        dependency
        for dependency in project_dependencies
        if re.match(r"^uv(?:\s|=|<|>|!|~|$)", dependency, flags=re.IGNORECASE)
    ]
    expected_uv_requirement = f"uv=={locked_uv_version}" if locked_uv_version else None
    if uv_requirements != [expected_uv_requirement]:
        violations.append(
            "pyproject.toml must pin uv exactly to the uv.lock version; "
            f"expected {expected_uv_requirement!r}, found {uv_requirements!r}"
        )

    required_uv_version = pyproject.get("tool", {}).get("uv", {}).get("required-version")
    expected_required_uv_version = f"=={locked_uv_version}" if locked_uv_version else None
    if required_uv_version != expected_required_uv_version:
        violations.append(
            "[tool.uv].required-version must match uv.lock; "
            f"expected {expected_required_uv_version!r}, found {required_uv_version!r}"
        )

    installer_source = _read("native/gsm-packages/src/python.rs").split("#[cfg(test)]", 1)[0]
    managed_uv_version = _rust_string_constant(installer_source, "UV_VERSION")
    if managed_uv_version != locked_uv_version:
        violations.append(f"Managed installer must use uv {locked_uv_version}; found {managed_uv_version!r}")

    pinned_python_version = _rust_string_constant(installer_source, "PYTHON_VERSION")
    if not pinned_python_version:
        violations.append("Managed compatibility installer must pin a Python version")

    root_project = next(
        (package for package in lock.get("package", []) if package.get("name") == "gamesentenceminer"),
        None,
    )
    project_version = pyproject.get("project", {}).get("version")
    if not root_project or root_project.get("version") != project_version:
        violations.append(
            "uv.lock project version must match pyproject.toml; "
            f"expected {project_version!r}, found {(root_project or {}).get('version')!r}"
        )

    for obsolete_path in (
        "requirements.lock",
        "runtime-lock-manifest.json",
        "scripts/generate_runtime_lock_manifest.py",
    ):
        if (ROOT / obsolete_path).exists():
            violations.append(
                f"Remove obsolete duplicate dependency artifact {obsolete_path}; uv.lock is authoritative"
            )

    workflow = _read(".github/workflows/test_python.yml")
    expected_workflow_snippets = (
        f'version: "{locked_uv_version}"',
        f'- "{pinned_python_version}"',
        "uv lock --check",
        "uv sync --frozen --extra dev",
        "python -m pip check",
    )
    for snippet in expected_workflow_snippets:
        if snippet not in workflow:
            violations.append(f"Python CI is missing dependency policy command: {snippet}")

    for path in (".github/workflows/test_python.yml", "run.ps1"):
        commands = _sync_commands_without_frozen(_read(path))
        for command in commands:
            violations.append(f"{path} contains an unfrozen dependency sync: {command}")

    if '"--frozen"' not in installer_source:
        violations.append("Managed runtime sync must pass --frozen")
    if '["-m", "pip", "check"]' not in installer_source:
        violations.append("Managed runtime sync must validate the result with pip check")

    return violations


def main() -> int:
    violations = get_policy_violations()
    if violations:
        print("Python dependency policy violations:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print("Python dependency policy is consistent (pyproject.toml + uv.lock are authoritative).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
