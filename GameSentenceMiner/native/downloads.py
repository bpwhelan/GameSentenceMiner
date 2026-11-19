"""Python callers of the shared Rust asset downloader."""

import os
from pathlib import Path


def download_file(url, destination, sha256=None, *, limit=1024**3, progress=None):
    from GameSentenceMiner import _native

    _native.download_file(url, Path(destination), sha256, limit=limit, progress=progress)


def asset_path(asset_id, bundled=None):
    from GameSentenceMiner import _native

    return _native.ensure_download_asset(_cache_root(), asset_id, bundled)


def cached_asset_path(asset_id):
    from GameSentenceMiner import _native

    return _native.cached_download_asset(_cache_root(), asset_id)


def huggingface_model(repo, filename, destination, *, revision="main", sha256=None):
    from huggingface_hub import try_to_load_from_cache

    destination = Path(destination)
    if destination.is_file():
        return destination
    cached = try_to_load_from_cache(repo, filename, revision=revision)
    if isinstance(cached, str):
        return Path(cached)
    download_file(f"https://huggingface.co/{repo}/resolve/{revision}/{filename}", destination, sha256)
    return destination


def _cache_root():
    from GameSentenceMiner.util.data_directory import get_shared_app_directory

    shared = os.environ.get("GSM_NATIVE_SHARED_DATA_DIR") or get_shared_app_directory()
    return Path(shared) / "downloads" / "v1"
