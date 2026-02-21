import os
import platform
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Iterable

from GameSentenceMiner.util.config.configuration import logger


SCREEN_AI_RESOURCE_ROOT = Path.home() / ".config" / "screen_ai"

SCREEN_AI_DOWNLOAD_URLS = {
    "linux": "https://r2.gamesentenceminer.com/screenai/screen-ai-linux.zip",
    "darwin_amd64": "https://r2.gamesentenceminer.com/screenai/screen-ai-mac-amd64.zip",
    "darwin_arm64": "https://r2.gamesentenceminer.com/screenai/screen-ai-mac-arm64.zip",
    "win32_386": "https://r2.gamesentenceminer.com/screenai/screen-ai-windows-386.zip",
    "win32_amd64": "https://r2.gamesentenceminer.com/screenai/screen-ai-windows-amd64.zip",
}


def _normalize_arch(machine: str) -> str:
    arch = (machine or "").strip().lower()
    if arch in {"amd64", "x86_64", "x64"}:
        return "amd64"
    if arch in {"arm64", "aarch64"}:
        return "arm64"
    if arch in {"x86", "i386", "i686"}:
        return "386"
    return arch


def _select_download_url() -> str | None:
    system = platform.system().lower()
    arch = _normalize_arch(platform.machine())

    if system == "linux":
        return SCREEN_AI_DOWNLOAD_URLS["linux"]

    if system == "darwin":
        if arch == "arm64":
            return SCREEN_AI_DOWNLOAD_URLS["darwin_arm64"]
        if arch in {"amd64", "386"}:
            return SCREEN_AI_DOWNLOAD_URLS["darwin_amd64"]
        return None

    if system == "windows":
        if arch == "386":
            return SCREEN_AI_DOWNLOAD_URLS["win32_386"]
        if arch in {"amd64", "arm64"}:
            return SCREEN_AI_DOWNLOAD_URLS["win32_amd64"]
        return None

    return None


def _resource_locations(root: Path) -> tuple[Path, Path]:
    return root, root / "resources"


def _has_any_library(root: Path, library_names: Iterable[str]) -> bool:
    for location in _resource_locations(root):
        for library_name in library_names:
            if (location / library_name).is_file():
                return True
    return False


def _download_archive(url: str, archive_path: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "GameSentenceMiner-ScreenAI-Downloader"},
    )
    with urllib.request.urlopen(request, timeout=120) as response, archive_path.open("wb") as output:
        shutil.copyfileobj(response, output)


def _extract_archive(archive_path: Path, destination: Path) -> int:
    extracted_count = 0
    with zipfile.ZipFile(archive_path, "r") as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue

            member_path = Path(member.filename)
            if not member_path.parts:
                continue

            if member_path.is_absolute() or ".." in member_path.parts:
                continue

            destination_path = destination / member_path
            destination_path.parent.mkdir(parents=True, exist_ok=True)

            with archive.open(member) as source, destination_path.open("wb") as target:
                shutil.copyfileobj(source, target)

            unix_mode = member.external_attr >> 16
            if unix_mode and os.name != "nt":
                try:
                    destination_path.chmod(unix_mode)
                except Exception:
                    pass

            extracted_count += 1

    if extracted_count == 0:
        raise RuntimeError("Downloaded ScreenAI archive was empty.")

    return extracted_count


def ensure_screen_ai_resources(library_names: Iterable[str]) -> bool:
    """Ensure ScreenAI resources exist under ~/.config/screen_ai."""
    library_names = [name for name in library_names if name]
    target_root = SCREEN_AI_RESOURCE_ROOT
    if _has_any_library(target_root, library_names):
        return True

    url = _select_download_url()
    if not url:
        logger.warning(
            f"ScreenAI auto-download is not supported on this platform: {platform.system()} {platform.machine()}"
        )
        return False

    target_root.mkdir(parents=True, exist_ok=True)
    logger.info("ScreenAI resources missing. Downloading...")

    archive_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as archive_file:
            archive_path = Path(archive_file.name)

        _download_archive(url, archive_path)
        extracted_count = _extract_archive(archive_path, target_root)
        logger.info(f"ScreenAI resources extracted to {target_root} ({extracted_count} files)")
    except Exception as e:
        logger.warning(f"ScreenAI resource auto-download failed: {e}")
        return _has_any_library(target_root, library_names)
    finally:
        if archive_path and archive_path.exists():
            try:
                archive_path.unlink()
            except Exception:
                pass

    if not _has_any_library(target_root, library_names):
        logger.warning(f"ScreenAI resources were downloaded but no library was found under {target_root}.")
        return False

    return True
