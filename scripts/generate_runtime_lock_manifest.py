#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import tomllib


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate runtime lock manifest with integrity hashes and allowed extras."
        )
    )
    parser.add_argument("--lock", default="uv.lock", help="Path to uv.lock")
    parser.add_argument(
        "--pyproject", default="pyproject.toml", help="Path to pyproject.toml"
    )
    parser.add_argument(
        "--output",
        default="runtime-lock-manifest.json",
        help="Output manifest path",
    )
    parser.add_argument(
        "--uv-version",
        default="",
        help="Pinned uv version used to produce the lock",
    )
    return parser.parse_args()


def load_project_metadata(pyproject_path: Path) -> tuple[str, str, list[str]]:
    project_name = ""
    project_version = ""
    extras: list[str] = []

    parsed = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    project = parsed.get("project", {})
    if isinstance(project, dict):
        name_value = project.get("name")
        if isinstance(name_value, str):
            project_name = name_value.strip()

        version_value = project.get("version")
        if isinstance(version_value, str):
            project_version = version_value.strip()

        optional_dependencies = project.get("optional-dependencies", {})
        if isinstance(optional_dependencies, dict):
            extras = sorted(
                {
                    str(extra_name).strip().lower()
                    for extra_name in optional_dependencies.keys()
                    if str(extra_name).strip()
                }
            )

    return project_name, project_version, extras


def main() -> int:
    args = parse_args()
    lock_path = Path(args.lock)
    pyproject_path = Path(args.pyproject)
    output_path = Path(args.output)

    if not lock_path.exists():
        raise FileNotFoundError(f"Lockfile not found: {lock_path}")
    if not pyproject_path.exists():
        raise FileNotFoundError(f"pyproject.toml not found: {pyproject_path}")

    project_name, project_version, allowed_extras = load_project_metadata(pyproject_path)
    generated_at = (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

    manifest = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "projectName": project_name,
        "projectVersion": project_version,
        "uvVersion": args.uv_version,
        "lockSha256": file_sha256(lock_path),
        "pyprojectSha256": file_sha256(pyproject_path),
        "allowedExtras": allowed_extras,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote runtime lock manifest: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
