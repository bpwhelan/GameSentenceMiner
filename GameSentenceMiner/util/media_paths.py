"""Prepare writable media folders without depending on the user's Videos folder."""

import os
import tempfile

from GameSentenceMiner.util.config import configuration


def same_directory(first: str, second: str) -> bool:
    return bool(first and second) and os.path.normcase(os.path.abspath(first)) == os.path.normcase(
        os.path.abspath(second)
    )


def _check_writable_directory(directory: str) -> None:
    os.makedirs(directory, exist_ok=True)
    # Existence/access flags alone do not catch ACLs, disconnected targets, or
    # folders where listing is allowed but creating recording files is not.
    with tempfile.NamedTemporaryFile(prefix=".gsm-write-check-", dir=directory) as probe:
        probe.write(b"GSM")
        probe.flush()


def get_writable_media_directory(directory: str, fallback_name: str) -> str:
    try:
        _check_writable_directory(directory)
        return directory
    except (OSError, ValueError) as error:
        configuration.logger.warning(f"Media folder {directory!r} is unavailable: {error}")

    # Keep recordings and copied output outside temp: startup deletes temp's
    # contents, including unfinished longplay recordings if they were put there.
    fallback = os.path.join(configuration.get_app_directory(), fallback_name)
    try:
        _check_writable_directory(fallback)
    except (OSError, ValueError) as error:
        raise OSError(
            f"Cannot use media folder {directory!r} or GSM's backup folder {fallback!r}: {error}. "
            "Choose a writable folder in GSM Settings > Paths and OBS Settings > Output."
        ) from error
    configuration.logger.warning(f"Using GSM's backup media folder: {fallback!r}")
    return fallback


def _save_path(field: str, directory: str) -> None:
    paths = configuration.get_config().paths
    if same_directory(getattr(paths, field), directory):
        return
    setattr(paths, field, directory)
    master = configuration.get_master_config()
    master.sync_shared_fields()
    try:
        configuration.save_full_config(master)
    except OSError as error:
        # The usable in-memory path still allows startup when config.json is
        # read-only. Do not claim the repair will survive the next launch.
        configuration.logger.error(f"Using {directory!r}, but could not save GSM's {field} setting: {error}")


def set_gsm_recording_directory(directory: str) -> None:
    _save_path("folder_to_watch", directory)


def ensure_recording_directory() -> str:
    directory = get_writable_media_directory(configuration.get_config().paths.folder_to_watch, "recordings")
    set_gsm_recording_directory(directory)
    return directory


def ensure_output_directory() -> str:
    directory = get_writable_media_directory(configuration.get_config().paths.output_folder, "output")
    _save_path("output_folder", directory)
    return directory
