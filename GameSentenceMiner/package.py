import os
from importlib import metadata

import requests

from GameSentenceMiner.configuration import logger, get_app_directory

PACKAGE_NAME = "GameSentenceMiner"
VERSION_FILE_PATH = os.path.join(get_app_directory(), 'version.txt')

def get_current_version():
    try:
        version = metadata.version(PACKAGE_NAME)
        return version
    except metadata.PackageNotFoundError:
        return None

def get_latest_version():
    try:
        response = requests.get(f"https://pypi.org/pypi/{PACKAGE_NAME}/json")
        latest_version = response.json()["info"]["version"]
        return latest_version
    except Exception as e:
        logger.error(f"Error fetching latest version: {e}")
        return None

def check_for_updates(force=False):
    try:
        installed_version = get_current_version()
        latest_version = get_latest_version()

        if installed_version != latest_version or force:
            logger.info(f"Update available: {installed_version} -> {latest_version}")
            return True, latest_version
        else:
            logger.info("You are already using the latest version.")
            return False, latest_version
    except Exception as e:
        logger.error(f"Error checking for updates: {e}")
