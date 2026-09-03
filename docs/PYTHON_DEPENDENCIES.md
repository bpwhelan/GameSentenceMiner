# Python dependency management

GameSentenceMiner has one authoritative Python dependency lock: `uv.lock`.
Do not create or maintain a parallel `requirements.lock`; two independently
generated lockfiles inevitably drift.

## Environment contract

- `pyproject.toml` declares direct runtime dependencies and the `dev`,
  `gpu`, and `lens` extras.
- `uv.lock` pins the complete cross-platform dependency graph, including
  artifact hashes.
- `.python-version` pins the Python used by developer environments and CI.
- The uv version is pinned in `pyproject.toml`, the managed Electron
  bootstrap, and CI. The policy test rejects any disagreement.
- Electron production environments install the locked runtime set without the
  dev group. Selected supported extras are included in the environment
  fingerprint.

The managed venv marker contains both an environment generation and the exact
Python version. Changing `.python-version` therefore causes a one-time rebuild
without spawning Python just to re-check its version on every startup.

The Electron runtime keeps intentionally installed optional OCR extensions, but
every lock sync restores all core packages to their locked versions and runs
`python -m pip check`. A successful sync is stamped with a hash of
`pyproject.toml`, `uv.lock`, `.python-version`, and the selected extras.
Lock-only, interpreter, and extra changes therefore trigger a sync without
repeated package-version probes.

## Common commands

```powershell
# Reproduce the developer/test environment exactly
uv sync --frozen --extra dev

# Add or remove a direct dependency (these update uv.lock)
uv add <package>
uv remove <package>

# Upgrade one dependency intentionally
uv lock --upgrade-package <package>

# Verify metadata, the lock, and the installed environment
.\run.ps1 verify-python
```

Commit `pyproject.toml` and `uv.lock` together whenever dependency metadata
changes. CI rejects an outdated lock, an unfrozen sync, toolchain-version drift,
or a broken installed requirement graph.
