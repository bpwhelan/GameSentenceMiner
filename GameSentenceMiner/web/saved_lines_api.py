"""API behind the Saved page: list saved lines, play their audio, enrich a card, move to trash."""

import base64
import hashlib
import mimetypes
import os
import re

from flask import Response, jsonify, request, send_file
from send2trash import send2trash

from GameSentenceMiner import anki, saved_line_cards
from GameSentenceMiner.util import saved_lines
from GameSentenceMiner.util.config.configuration import get_config, get_temporary_directory, logger


def _saved_root() -> str:
    output_folder = get_config().paths.output_folder
    return saved_lines.get_saved_lines_root(output_folder) if output_folder else ""


def _resolve(saved_id: str | None) -> str | None:
    """Map an id like "2026-09-28/00-21-27-412_text" to its folder, refusing anything outside Saved/."""
    root = _saved_root()
    if not root or not saved_id or os.path.isabs(saved_id):
        return None
    root = os.path.realpath(root)
    folder = os.path.realpath(os.path.join(root, saved_id))
    if folder == root or os.path.commonpath([root, folder]) != root:
        return None
    return folder if os.path.isfile(os.path.join(folder, saved_lines.MANIFEST_NAME)) else None


def _summary(saved: saved_lines.SavedLine, root: str) -> dict:
    first = saved.selected[0] if saved.selected else None
    return {
        "id": os.path.relpath(saved.folder, root).replace(os.sep, "/"),
        "game": saved.game,
        "sentence": saved.manifest.get("sentence", ""),
        "line_time": first.time.isoformat() if first else "",
        "saved_at": saved.manifest.get("saved_at", ""),
        "cards": saved.manifest.get("cards", []),
        "lines": [{"text": entry["text"], "role": entry.get("role", "")} for entry in saved.manifest["lines"]],
    }


_CARD_MEDIA_PATTERNS = {
    "audio": re.compile(r"\[sound:([^\]]+)\]"),
    "picture": re.compile(r"<img[^>]*\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE),
}


def register_saved_lines_api_routes(app):
    @app.route("/api/saved-lines", methods=["GET"])
    def saved_lines_list():
        root = _saved_root()
        if not root:
            return jsonify({"saved_lines": [], "error": "No output folder is set in the Paths settings."})
        items = [_summary(saved, os.path.realpath(root)) for saved in saved_lines.iter_saved_lines(root)]
        items.sort(key=lambda item: item["line_time"], reverse=True)
        return jsonify({"saved_lines": items})

    @app.route("/api/saved-lines", methods=["DELETE"])
    def saved_lines_delete():
        folder = _resolve(request.args.get("id"))
        if not folder:
            return jsonify({"error": "Saved line not found."}), 404
        try:
            send2trash(folder)
        except Exception as e:
            logger.exception(f"Failed to move saved line to the trash: {folder}")
            return jsonify({"error": f"Could not move it to the trash: {e}"}), 500
        return jsonify({"trashed": request.args.get("id")})

    @app.route("/api/saved-lines/audio", methods=["GET"])
    def saved_lines_audio():
        folder = _resolve(request.args.get("id"))
        if not folder:
            return jsonify({"error": "Saved line not found."}), 404
        saved = saved_lines.load_saved_line(folder)
        name = hashlib.sha1(folder.encode("utf-8")).hexdigest()[:16]
        output_path = os.path.join(get_temporary_directory(), f"saved_line_{name}.mp3")
        saved_lines.extract_line_audio(saved, output_path)
        if not os.path.isfile(output_path):
            return jsonify({"error": "Could not extract the line's audio."}), 500
        return send_file(output_path, mimetype="audio/mpeg", conditional=True)

    @app.route("/api/saved-lines/card-media", methods=["GET"])
    def saved_lines_card_media():
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
            note = anki.invoke("notesInfo", notes=[note_id])[0]
            match = pattern.search(note["fields"].get(field, {}).get("value", "") or "")
            data = anki.invoke("retrieveMediaFile", filename=match.group(1)) if match else False
        except Exception as e:
            logger.warning(f"Could not fetch the latest card's {kind} from Anki: {e}")
            return jsonify({"error": "Couldn't reach Anki."}), 502
        if not data:
            return jsonify({"error": "The card has no such media."}), 404
        mimetype = mimetypes.guess_type(match.group(1))[0] or "application/octet-stream"
        return Response(base64.b64decode(data), mimetype=mimetype, headers={"Cache-Control": "no-store"})

    @app.route("/api/saved-lines/enrich", methods=["POST"])
    def saved_lines_enrich():
        data = request.get_json() or {}
        folder = _resolve(data.get("id"))
        if not folder:
            return jsonify({"error": "Saved line not found."}), 404
        try:
            card = anki.get_last_anki_card()
        except Exception as e:
            logger.warning(f"Enrich latest card: could not reach Anki: {e}")
            return jsonify({"error": "Couldn't reach Anki. Make sure Anki is open with AnkiConnect installed."}), 502
        if not card:
            return jsonify({"error": "No card was added to Anki today. Add one with Yomitan first."}), 404

        saved = saved_lines.load_saved_line(folder)
        check = saved_line_cards.check_enrich(card, saved)
        codes = {warning["code"] for warning in check["warnings"]}
        if "live_pending" in codes:
            return jsonify({**check, "can_confirm": False}), 409
        if codes and not data.get("confirm"):
            return jsonify({**check, "can_confirm": True}), 409
        # A fresh matching card keeps Yomitan's sentence; anything else is rewritten from the saved line.
        saved_line_cards.enrich_from_saved_line(card, saved, rewrite=bool(codes))
        return jsonify({"queued": True, "note_id": card.noteId}), 202
