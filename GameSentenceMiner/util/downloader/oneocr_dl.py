import os
import time
import zipfile
import shutil
from os.path import expanduser

import requests
import re
import tempfile

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
    return None # Return None if not found in cache

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
    return path # Assuming path is a URL here based on usage

# Simplified download logic extracted from the question class
class Downloader:
    def __init__(self):
        self.oneocr_dir = expanduser("~/.config/oneocr")
        self.packageFamilyName = "Microsoft.ScreenSketch_8wekyb3d8bbwe"
        self.flist = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"]

    def download_and_extract(self):
        """
        Main function to attempt download and extraction.
        Tries official source first, then a fallback URL.
        """
        if checkdir(self.oneocr_dir):
            print("Files already exist in cache.")
            return True

        try:
            print("Attempting to download from official source...")
            # raise Exception("")
            self.downloadofficial()
            print("Download and extraction from official source successful.")
            return True
        except Exception as e:
            print(f"Download from official source failed: {stringfyerror(e)}")
            print("Attempting to download from fallback URL...")
            try:
                fallback_url = "https://gsm.beangate.us/oneocr.zip"
                self.downloadx(fallback_url)
                print("Download and extraction from fallback URL successful.")
                return True
            except Exception as e_fallback:
                print(f"Download from fallback URL failed: {stringfyerror(e_fallback)}")
                print("All download attempts failed.")
                return False


    def downloadofficial(self):
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
        response.raise_for_status() # Raise an exception for bad status codes

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

        print(f"Downloading {package_name} from {url}")
        req = requests.get(url, stream=True, proxies=getproxy())
        req.raise_for_status()

        total_size_in_bytes = int(req.headers.get('content-length', 0))
        block_size = 1024 * 32 # 32 Kibibytes
        temp_msixbundle_path = os.path.join(tempfile.gettempdir(), package_name)

        with open(temp_msixbundle_path, "wb") as ff:
            downloaded_size = 0
            for chunk in req.iter_content(chunk_size=block_size):
                ff.write(chunk)
                downloaded_size += len(chunk)
                # Basic progress reporting (can be removed)
                if total_size_in_bytes:
                    progress = (downloaded_size / total_size_in_bytes) * 100
                    print(f"Downloaded {downloaded_size}/{total_size_in_bytes} bytes ({progress:.2f}%)", end='\r')
        print("\nDownload complete. Extracting...")

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

        print(f"Extracted {namemsix}. Extracting components...")
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


    def downloadx(self, url: str):
        """Downloads a zip file from a URL and extracts it."""
        print(f"Downloading from fallback URL")
        # Added accept-language to the fallback download as well for consistency
        headers = {
             "accept-language": "en-US,en;q=0.9",
             # Add other relevant headers if necessary for the fallback URL
             "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
             "accept": "*/*",
        }
        req = requests.get(url, verify=False, proxies=getproxy(), stream=True, headers=headers)
        req.raise_for_status()

        total_size_in_bytes = int(req.headers.get('content-length', 0))
        block_size = 1024 * 32 # 32 Kibibytes
        temp_zip_path = os.path.join(tempfile.gettempdir(), url.split("/")[-1])

        with open(temp_zip_path, "wb") as ff:
            downloaded_size = 0
            for chunk in req.iter_content(chunk_size=block_size):
                ff.write(chunk)
                downloaded_size += len(chunk)
                 # Basic progress reporting (can be removed)
                if total_size_in_bytes:
                    progress = (downloaded_size / total_size_in_bytes) * 100
                    print(f"Downloaded {downloaded_size}/{total_size_in_bytes} bytes ({progress:.2f}%)", end='\r')
        print("\nDownload complete. Extracting...")

        if os.path.exists(self.oneocr_dir):
             shutil.rmtree(self.oneocr_dir)
        os.makedirs(self.oneocr_dir, exist_ok=True)

        with zipfile.ZipFile(temp_zip_path) as zipf:
            zipf.extractall(self.oneocr_dir)

        if not checkdir(self.oneocr_dir):
            raise Exception("Extraction failed: Required files not found in cache directory.")

        # Clean up temporary files
        os.remove(temp_zip_path)

# Example usage:
if __name__ == "__main__":
    downloader = Downloader()
    downloader.download_and_extract()
    # if downloader.download_and_extract():
    #     print("SnippingTool files are ready.")
    #     print("Press Ctrl+C or X on window to exit.")
    #     # input()
    # else:
    #     # print("Failed to download and extract SnippingTool files. You may need to follow instructions at https://github.com/AuroraWright/oneocr")
    #     print("Press Ctrl+C or X on window to exit.")
    #     input()
