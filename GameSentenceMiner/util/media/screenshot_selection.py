"""Ordered, invocation-scoped screenshot selections and their exported media."""

from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


@dataclass(frozen=True)
class ScreenshotChoice:
    start: float
    preview_path: str

    def key(self):
        # Timestamp identity is intentional: visually similar frames are distinct.
        return round(self.start, 3)


@dataclass(frozen=True)
class ScreenshotMedia:
    path: str
    start: float


@dataclass(frozen=True)
class ScreenshotSelectionResult:
    source_path: str
    items: tuple[ScreenshotMedia, ...]

    def __post_init__(self):
        if not self.items:
            raise ValueError("A screenshot result must contain at least one item")
        if any(not item.path for item in self.items):
            raise ValueError("Every selected screenshot needs an exported path")


def export_choices(source_path: str, choices: tuple[ScreenshotChoice, ...], duration: float, cancelled=None):
    """Export all choices before exposing a result to the note update pipeline."""
    if not choices:
        raise ValueError("Select at least one screenshot")
    from GameSentenceMiner.util.config.configuration import get_config, get_temporary_directory
    from GameSentenceMiner.util.media import ffmpeg

    output_directory = Path(get_temporary_directory())
    output_directory.mkdir(parents=True, exist_ok=True)
    exported = []
    generated_paths = []
    try:
        for choice in choices:
            if cancelled and cancelled():
                raise RuntimeError("Screenshot selection cancelled")
            if not 0 <= choice.start <= duration or not Path(choice.preview_path).is_file():
                raise ValueError("The selected still frame is unavailable; choose it again")
            destination = output_directory / f"selector_{uuid4().hex}.{get_config().screenshot.extension}"
            generated_paths.append(destination)
            path = ffmpeg.encode_screenshot(
                choice.preview_path,
                output_path=str(destination),
                already_processed=True,
            )
            if not path or not Path(path).is_file() or Path(path).stat().st_size == 0:
                raise RuntimeError(f"Screenshot export produced no media at {path}")
            exported.append(ScreenshotMedia(str(path), choice.start))
        if cancelled and cancelled():
            raise RuntimeError("Screenshot selection cancelled")
        return ScreenshotSelectionResult(source_path, tuple(exported))
    except Exception:
        for path in {*generated_paths, *(Path(item.path) for item in exported)}:
            path.unlink(missing_ok=True)
        raise
