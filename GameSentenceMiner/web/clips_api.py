"""API behind the Text Feed's saved clips: list them, open their folder and move them to the trash."""

import os

from flask import jsonify, request
from send2trash import send2trash
from werkzeug.security import safe_join

from GameSentenceMiner.util import clips
from GameSentenceMiner.util.config.configuration import logger


def _resolve(clip_id: str | None) -> str | None:
    """Map an id like "2026-09-28/00-21-27-412_text" to its folder, refusing anything outside Clips/."""
    root = clips.get_clips_root()
    folder = safe_join(root, clip_id) if root and clip_id else None
    return folder if folder and os.path.isfile(os.path.join(folder, clips.MANIFEST_NAME)) else None


def _summary(clip: clips.Clip, root: str) -> dict:
    return {
        "id": os.path.relpath(clip.folder, root).replace(os.sep, "/"),
        "size_bytes": os.path.getsize(clip.clip_path) if os.path.isfile(clip.clip_path) else 0,
        "lines": [{"id": line.id, "text": line.text} for line in clip.selected],
    }


def register_clips_api_routes(app):
    @app.route("/api/clips", methods=["GET"])
    def clips_list():
        root = clips.get_clips_root()
        if not root:
            return jsonify({"clips": [], "error": "No output folder is set in the Paths settings."})
        # Folders are named by date and time, so reversed folder order is newest first.
        return jsonify({"clips": [_summary(clip, root) for clip in reversed(list(clips.iter_clips(root)))]})

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
