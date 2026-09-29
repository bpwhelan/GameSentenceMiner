"""API behind the Text Feed's saved clips: list them, open their folder and move them to the trash."""

import os

from flask import jsonify, request
from send2trash import send2trash

from GameSentenceMiner.util import clips
from GameSentenceMiner.util.config.configuration import logger


def _resolve(clip_id: str | None) -> str | None:
    """Map an id like "2026-09-28/00-21-27-412_text" to its folder, refusing anything outside Clips/."""
    root = clips.get_clips_root()
    if not root or not clip_id or os.path.isabs(clip_id):
        return None
    root = os.path.realpath(root)
    folder = os.path.realpath(os.path.join(root, clip_id))
    if folder == root or os.path.commonpath([root, folder]) != root:
        return None
    return folder if os.path.isfile(os.path.join(folder, clips.MANIFEST_NAME)) else None


def _summary(clip: clips.Clip, root: str) -> dict:
    first = clip.selected[0] if clip.selected else None
    return {
        "id": os.path.relpath(clip.folder, root).replace(os.sep, "/"),
        "game": clip.game,
        "line_time": first.time.isoformat() if first else "",
        "cards": clip.manifest.get("cards", []),
        "size_bytes": sum(entry.stat().st_size for entry in os.scandir(clip.folder) if entry.is_file()),
        "lines": [{"id": line.id, "text": line.text} for line in clip.selected],
    }


def register_clips_api_routes(app):
    @app.route("/api/clips", methods=["GET"])
    def clips_list():
        root = clips.get_clips_root()
        if not root:
            return jsonify({"clips": [], "error": "No output folder is set in the Paths settings."})
        items = [_summary(clip, os.path.realpath(root)) for clip in clips.iter_clips(root)]
        items.sort(key=lambda item: item["line_time"], reverse=True)
        return jsonify({"clips": items})

    def _trash(clip_id: str) -> str | None:
        """Move one clip to the system trash; return an error message, or None on success."""
        folder = _resolve(clip_id)
        if not folder:
            return "Clip not found."
        try:
            send2trash(folder)
        except Exception as e:
            logger.exception(f"Failed to move clip to the trash: {folder}")
            return f"Could not move it to the trash: {e}"
        return None

    @app.route("/api/clips/open", methods=["POST"])
    def clips_open_folder():
        folder = _resolve((request.get_json() or {}).get("id"))
        if not folder:
            return jsonify({"error": "Clip not found."}), 404
        from GameSentenceMiner.web.service import _open_folder

        _open_folder(folder)
        return jsonify({"opened": True})

    @app.route("/api/clips/trash", methods=["POST"])
    def clips_trash_many():
        ids = (request.get_json() or {}).get("ids") or []
        if not isinstance(ids, list) or not ids:
            return jsonify({"error": "No clips selected."}), 400
        trashed, failed = [], []
        for clip_id in ids:
            error = _trash(clip_id) if isinstance(clip_id, str) else "Clip not found."
            if error:
                failed.append({"id": clip_id, "error": error})
            else:
                trashed.append(clip_id)
        return jsonify({"trashed": trashed, "failed": failed})
