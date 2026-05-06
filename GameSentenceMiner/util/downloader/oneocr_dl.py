import os
import re
import platform
import requests
import shutil
import subprocess
import tempfile
import time
import zipfile
from os.path import expanduser

from GameSentenceMiner.util.communication.electron_ipc import send_install_progress
from GameSentenceMiner.util.config.configuration import logger


DOWNLOAD_PROGRESS_MIN_INTERVAL_S = 0.25
DOWNLOAD_PROGRESS_MIN_BYTES = 512 * 1024
DOWNLOAD_PROGRESS_MIN_RATIO = 0.01


# Placeholder functions/constants for removed proprietary ones
# In a real application, you would replace these with appropriate logic
# or standard library equivalents.


def checkdir(d):
    """Checks if a directory exists and contains the expected files."""
    flist = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"]
    return os.path.isdir(d) and all((os.path.isfile(os.path.join(d, _)) for _ in flist))


def selectdir():
    """Attempts to find the SnippingTool directory, prioritizing cache."""
    cachedir = "cache/SnippingTool"
    packageFamilyName = "Microsoft.ScreenSketch_8wekyb3d8bbwe"

    if checkdir(cachedir):
        return cachedir
    # This part needs NativeUtils.GetPackagePathByPackageFamily, which is proprietary.
    # We'll skip this part for simplification as requested.
    # path = NativeUtils.GetPackagePathByPackageFamily(packageFamilyName)
    # if not path:
    #     return None
    # path = os.path.join(path, "SnippingTool")
    # if not checkdir(path):
    #     return None
    # return path
    return None  # Return None if not found in cache


def getproxy():
    """Placeholder for proxy retrieval."""
    # Replace with actual proxy retrieval logic or return None
    return None


def stringfyerror(e):
    """Placeholder for error stringification."""
    return str(e)


def dynamiclink(path):
    """Placeholder for dynamic link resolution."""
    # This would likely map a resource path to a local file path.
    # For simplification, we'll just use the provided path string.
    return path  # Assuming path is a URL here based on usage


def report_install_progress(
    stage_id,
    status,
    progress_kind="indeterminate",
    progress=None,
    message="",
    downloaded_bytes=None,
    total_bytes=None,
    error=None,
):
    if not stage_id:
        return
    try:
        send_install_progress(
            stage_id=stage_id,
            status=status,
            progress_kind=progress_kind,
            progress=progress,
            message=message,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            error=error,
        )
    except Exception:
        pass


def should_emit_download_progress(
    downloaded_bytes,
    total_bytes,
    last_reported_bytes,
    last_reported_at,
):
    now = time.monotonic()
    if downloaded_bytes <= 0:
        return False
    if total_bytes and downloaded_bytes >= total_bytes:
        return True

    bytes_delta = downloaded_bytes - last_reported_bytes
    ratio_delta = (downloaded_bytes - last_reported_bytes) / total_bytes if total_bytes and total_bytes > 0 else 0
    time_delta = now - last_reported_at
    return (
        bytes_delta >= DOWNLOAD_PROGRESS_MIN_BYTES
        or ratio_delta >= DOWNLOAD_PROGRESS_MIN_RATIO
        or time_delta >= DOWNLOAD_PROGRESS_MIN_INTERVAL_S
    )


# Simplified download logic extracted from the question class
class Downloader:
    def __init__(self):
        self.oneocr_dir = expanduser("~/.config/oneocr")
        self.packageFamilyName = "Microsoft.ScreenSketch_8wekyb3d8bbwe"
        self.flist = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"]

    def download_and_extract(self, stage_id=None):
        """
        Main function to attempt download and extraction.
        Tries official source first, then a fallback URL.
        """
        if checkdir(self.oneocr_dir):
            return "skipped"
        if self._copy_files_if_needed(stage_id=stage_id):
            return "completed"

        try:
            logger.info("Attempting to download OneOCR files from official source...")
            # raise Exception("")
            self.downloadofficial(stage_id=stage_id)
            logger.success("Download and extraction from official source successful.")
            return "completed"
        except Exception as e:
            logger.info(f"Download from official source failed: {stringfyerror(e)}")
            logger.info("Attempting to download from fallback URL...")
            try:
                fallback_url = "https://gsm.beangate.us/oneocr.zip"
                self.downloadx(fallback_url, stage_id=stage_id)
                logger.success("Download and extraction from fallback URL successful.")
                return "completed"
            except Exception as e_fallback:
                logger.info(f"Download from fallback URL failed: {stringfyerror(e_fallback)}")
                logger.info("All download attempts failed.")
                raise RuntimeError(f"All OneOCR download attempts failed: {stringfyerror(e_fallback)}") from e_fallback

    def _copy_files_if_needed(self, stage_id=None):
        target_path = os.path.join(os.path.expanduser("~"), ".config", "oneocr")
        files_to_copy = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"]
        copy_needed = False

        for filename in files_to_copy:
            file_target_path = os.path.join(target_path, filename)
            if not os.path.exists(file_target_path):
                copy_needed = True

        if not copy_needed:
            report_install_progress(
                stage_id,
                status="skipped",
                progress_kind="indeterminate",
                progress=1,
                message="OneOCR runtime already installed.",
            )
            return True

        if int(platform.release()) < 11:
            logger.info(f"Unable to find OneOCR files in {target_path}, OneOCR will not work!")
            return False

        logger.info(f"Copying OneOCR files to {target_path}")

        cmd = [
            "powershell",
            "-Command",
            "Get-AppxPackage Microsoft.ScreenSketch | Select-Object -ExpandProperty InstallLocation",
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, shell=True, check=True)
            snipping_path = result.stdout.strip()
        except Exception:
            snipping_path = None

        if not snipping_path:
            logger.info("Error getting Snipping Tool folder, OneOCR will not work!")
            return False

        source_path = os.path.join(snipping_path, "SnippingTool")
        if not os.path.exists(source_path):
            logger.info("Error getting OneOCR SnippingTool folder, OneOCR will not work!")
            return False

        os.makedirs(target_path, exist_ok=True)

        for filename in files_to_copy:
            file_source_path = os.path.join(source_path, filename)
            file_target_path = os.path.join(target_path, filename)

            if os.path.exists(file_source_path):
                try:
                    shutil.copy2(file_source_path, file_target_path)
                except Exception as e:
                    logger.info(f"Error copying {file_source_path}: {e}, OneOCR will not work!")
                    return False
            else:
                logger.info(f"File not found {file_source_path}, OneOCR will not work!")
                return False
        report_install_progress(
            stage_id,
            status="completed",
            progress_kind="estimated",
            progress=1,
            message="Copied OneOCR runtime from the system Snipping Tool install.",
        )
        return True

    def downloadofficial(self, stage_id=None):
        """Downloads the latest SnippingTool MSIX bundle from a store API."""
        headers = {
            "accept": "*/*",
            # Changed accept-language to prioritize US English
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "origin": "https://store.rg-adguard.net",
            "pragma": "no-cache",
            "priority": "u=1, i",
            "referer": "https://store.rg-adguard.net/",
            "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        }

        data = dict(type="PackageFamilyName", url=self.packageFamilyName)

        response = requests.post(
            "https://store.rg-adguard.net/api/GetFiles",
            headers=headers,
            data=data,
            proxies=getproxy(),
        )
        response.raise_for_status()  # Raise an exception for bad status codes

        saves = []
        for link, package in re.findall('<a href="(.*?)".*?>(.*?)</a>', response.text):
            if not package.startswith("Microsoft.ScreenSketch"):
                continue
            if not package.endswith(".msixbundle"):
                continue
            version = re.search(r"\d+\.\d+\.\d+\.\d+", package)
            if not version:
                continue
            version = tuple(int(_) for _ in version.group().split("."))
            saves.append((version, link, package))

        if not saves:
            raise Exception("Could not find suitable download link from official source.")

        saves.sort(key=lambda _: _[0])
        url = saves[-1][1]
        package_name = saves[-1][2]

        logger.info(f"Downloading {package_name} from {url}")
        req = requests.get(url, stream=True, proxies=getproxy())
        req.raise_for_status()

        total_size_in_bytes = int(req.headers.get("content-length", 0))
        block_size = 1024 * 32  # 32 Kibibytes
        temp_msixbundle_path = os.path.join(tempfile.gettempdir(), package_name)
        last_reported_bytes = 0
        last_reported_at = 0.0

        with open(temp_msixbundle_path, "wb") as ff:
            downloaded_size = 0
            for chunk in req.iter_content(chunk_size=block_size):
                ff.write(chunk)
                downloaded_size += len(chunk)
                if should_emit_download_progress(
                    downloaded_size,
                    total_size_in_bytes,
                    last_reported_bytes,
                    last_reported_at,
                ):
                    report_install_progress(
                        stage_id,
                        status="running",
                        progress_kind="bytes",
                        progress=(downloaded_size / total_size_in_bytes),
                        message="Downloading OneOCR from the official source...",
                        downloaded_bytes=downloaded_size,
                        total_bytes=total_size_in_bytes,
                    )
                    last_reported_bytes = downloaded_size
                    last_reported_at = time.monotonic()
        logger.info("Download complete. Extracting...")

        namemsix = None
        with zipfile.ZipFile(temp_msixbundle_path) as ff:
            for name in ff.namelist():
                if name.startswith("SnippingTool") and name.endswith("_x64.msix"):
                    namemsix = name
                    break
            if not namemsix:
                raise Exception("Could not find MSIX file within MSIXBUNDLE.")
            temp_msix_path = os.path.join(tempfile.gettempdir(), namemsix)
            ff.extract(namemsix, tempfile.gettempdir())

        logger.info(f"Extracted {namemsix}. Extracting components...")
        if os.path.exists(self.oneocr_dir):
            shutil.rmtree(self.oneocr_dir)
        os.makedirs(self.oneocr_dir, exist_ok=True)

        with zipfile.ZipFile(temp_msix_path) as ff:
            collect = []
            for name in ff.namelist():
                # Extract only the files within the "SnippingTool/" directory
                if name.startswith("SnippingTool/") and any(name.endswith(f) for f in self.flist):
                    # Construct target path relative to cachedir
                    target_path = os.path.join(self.oneocr_dir, os.path.relpath(name, "SnippingTool/"))
                    # Ensure parent directories exist
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    # Extract the file
                    with ff.open(name) as source, open(target_path, "wb") as target:
                        shutil.copyfileobj(source, target)
                    collect.append(name)
            if not collect:
                raise Exception("Could not find required files within MSIX.")

        if not checkdir(self.oneocr_dir):
            raise Exception("Extraction failed: Required files not found in cache directory.")

        # Clean up temporary files
        os.remove(temp_msixbundle_path)
        os.remove(temp_msix_path)

    def downloadx(self, url: str, stage_id=None):
        """Downloads a zip file from a URL and extracts it."""
        logger.info("Downloading OneOCR from fallback URL")

        response = requests.get(url, stream=True)
        response.raise_for_status()

        temp_zip_path = os.path.join(tempfile.gettempdir(), os.path.basename(url))

        with open(temp_zip_path, "wb") as f:
            last_reported_bytes = 0
            last_reported_at = 0.0
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
                downloaded_bytes = f.tell()
                total_bytes = response.headers.get("Content-Length")
                parsed_total = int(total_bytes) if str(total_bytes).isdigit() else None
                if should_emit_download_progress(
                    downloaded_bytes,
                    parsed_total,
                    last_reported_bytes,
                    last_reported_at,
                ):
                    report_install_progress(
                        stage_id,
                        status="running",
                        progress_kind="bytes",
                        progress=(downloaded_bytes / parsed_total) if parsed_total else None,
                        message="Downloading OneOCR fallback bundle...",
                        downloaded_bytes=downloaded_bytes,
                        total_bytes=parsed_total,
                    )
                    last_reported_bytes = downloaded_bytes
                    last_reported_at = time.monotonic()

        logger.info("Download complete. Extracting...")

        if os.path.exists(self.oneocr_dir):
            shutil.rmtree(self.oneocr_dir)
        os.makedirs(self.oneocr_dir, exist_ok=True)

        with zipfile.ZipFile(temp_zip_path, "r") as zip_ref:
            zip_ref.extractall(self.oneocr_dir)

        if not checkdir(self.oneocr_dir):
            raise Exception("Extraction failed: Required files not found in cache directory.")

        os.remove(temp_zip_path)


# Example usage:
if __name__ == "__main__":
    downloader = Downloader()
    # downloader.download_and_extract()
    downloader.downloadx("https://gsm.beangate.us/oneocr.zip")
    # if downloader.download_and_extract():
    #     logger.info("SnippingTool files are ready.")
    #     logger.info("Press Ctrl+C or X on window to exit.")
    #     # input()
    # else:
    #     # logger.info("Failed to download and extract SnippingTool files. You may need to follow instructions at https://github.com/AuroraWright/oneocr")
    #     logger.info("Press Ctrl+C or X on window to exit.")
    #     input()
