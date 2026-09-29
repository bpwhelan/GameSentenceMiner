"""API behind the Clips to mine page: list clips, play their audio, enrich a card, move to trash."""

import base64
import mimetypes
import os
import re

from flask import Response, jsonify, request, send_file
from send2trash import send2trash

from GameSentenceMiner import anki, clip_cards
from GameSentenceMiner.util import clips
from GameSentenceMiner.util.config.configuration import get_config, logger

# Preview audio per clip folder; clips never change, and temp is wiped at startup.
_preview_audio: dict[str, str] = {}


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
        "sentence": clip.manifest.get("sentence", ""),
        "line_ids": [line.id for line in clip.selected],
        "line_time": first.time.isoformat() if first else "",
        "saved_at": clip.manifest.get("saved_at", ""),
        "cards": clip.manifest.get("cards", []),
        "lines": [{"text": entry["text"], "role": entry.get("role", "")} for entry in clip.manifest["lines"]],
    }


_CARD_MEDIA_PATTERNS = {
    "audio": re.compile(r"\[sound:([^\]]+)\]"),
    "picture": re.compile(r"<img[^>]*\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE),
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

    @app.route("/api/clips/audio", methods=["GET"])
    def clips_audio():
        folder = _resolve(request.args.get("id"))
        if not folder:
            return jsonify({"error": "Clip not found."}), 404
        audio = _preview_audio.get(folder)
        if not audio or not os.path.isfile(audio):
            audio = clip_cards.clip_line_audio(clips.load_clip(folder))
            if not audio or not os.path.isfile(audio):
                return jsonify({"error": "Could not extract the line's audio."}), 500
            _preview_audio[folder] = audio
        return send_file(audio, mimetype="audio/wav", conditional=True)

    @app.route("/api/clips/card-media", methods=["GET"])
    def clips_card_media():
        """Serve the latest card's current audio or picture so the page can show what Enrich replaces."""
        kind = request.args.get("kind", "")
        pattern = _CARD_MEDIA_PATTERNS.get(kind)
        try:
            note_id = int(request.args.get("note_id", ""))
        except ValueError:
            note_id = None
        if pattern is None or note_id is None:
            return jsonify({"error": "Unknown media."}), 404
        try:
            # Only the latest card, the one the confirmation shows, is served.
            latest = anki.get_last_anki_card()
            if not latest or latest.noteId != note_id:
                return jsonify({"error": "Only the latest card's media can be shown."}), 404
            config = get_config()
            field = config.anki.sentence_audio_field if kind == "audio" else config.anki.picture_field
            match = pattern.search(latest.get_field(field) if latest.has_field(field) else "")
            data = anki.invoke("retrieveMediaFile", filename=match.group(1)) if match else False
        except Exception as e:
            logger.warning(f"Could not fetch the latest card's {kind} from Anki: {e}")
            return jsonify({"error": "Couldn't reach Anki."}), 502
        if not data:
            return jsonify({"error": "The card has no such media."}), 404
        mimetype = mimetypes.guess_type(match.group(1))[0] or "application/octet-stream"
        return Response(base64.b64decode(data), mimetype=mimetype, headers={"Cache-Control": "no-store"})

    @app.route("/api/clips/enrich", methods=["POST"])
    def clips_enrich():
        data = request.get_json() or {}
        folder = _resolve(data.get("id"))
        if not folder:
            return jsonify({"error": "Clip not found."}), 404
        try:
            card = anki.get_last_anki_card()
        except Exception as e:
            logger.warning(f"Enrich latest card: could not reach Anki: {e}")
            return jsonify({"error": "Couldn't reach Anki. Make sure Anki is open with AnkiConnect installed."}), 502
        if not card:
            return jsonify({"error": "No card was added to Anki today. Add one with Yomitan first."}), 404

        clip = clips.load_clip(folder)
        check = clip_cards.check_enrich(card, clip)
        codes = {warning["code"] for warning in check["warnings"]}
        if "live_pending" in codes:
            return jsonify({**check, "can_confirm": False}), 409
        if codes and not data.get("confirm"):
            return jsonify({**check, "can_confirm": True}), 409
        # A fresh matching card keeps Yomitan's sentence; anything else is rewritten from the clip.
        clip_cards.enrich_from_clip(card, clip, rewrite=bool(codes))
        return jsonify({"queued": True, "note_id": card.noteId}), 202
