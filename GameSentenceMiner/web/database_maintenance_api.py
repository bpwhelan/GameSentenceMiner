"""Database maintenance controls with bounded asynchronous jobs."""

from collections import OrderedDict
from threading import Lock
from uuid import uuid4

from flask import jsonify, request, send_file

from GameSentenceMiner.util.concurrency.work_pool import get_background_work_pool
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.archive_files import (
    archive_directory,
    archive_file_by_id,
    delete_archive_file_by_id,
    list_archive_files,
    restore_archive_file_by_id,
)
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.maintenance import (
    database_storage,
    maintenance_lock,
    maintenance_settings,
    save_maintenance_settings,
    vacuum_database,
)


def register_database_maintenance_routes(app):
    jobs, jobs_lock = OrderedDict(), Lock()

    def start_job(action):
        if GameLinesTable._db.read_only:
            return jsonify({"error": "Database is read-only"}), 403
        if not maintenance_lock.acquire(blocking=False):
            return jsonify({"error": "Database maintenance is already running"}), 409
        job_id = str(uuid4())
        with jobs_lock:
            jobs[job_id] = {"id": job_id, "status": "running"}
            while len(jobs) > 20:
                jobs.popitem(last=False)

        def report_progress(**progress):
            with jobs_lock:
                jobs[job_id].update(progress)

        def run():
            try:
                result = action(report_progress)
                report_progress(status="completed", result=result)
            except Exception as exc:  # noqa: BLE001 - surface asynchronous failures in the job response
                logger.exception("Database maintenance failed")
                report_progress(status="failed", error=str(exc))
            finally:
                maintenance_lock.release()

        try:
            get_background_work_pool().submit(run)
        except Exception:
            maintenance_lock.release()
            with jobs_lock:
                jobs.pop(job_id, None)
            raise
        return jsonify({"id": job_id, "status": "running"}), 202

    @app.get("/api/database/maintenance")
    def status():
        return jsonify({"settings": maintenance_settings(), "storage": database_storage()})

    @app.put("/api/database/maintenance")
    def settings():
        if GameLinesTable._db.read_only:
            return jsonify({"error": "Database is read-only"}), 403
        try:
            return jsonify({"settings": save_maintenance_settings(request.get_json(silent=True))})
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/database/vacuum")
    def vacuum():
        return start_job(lambda progress: vacuum_database())

    @app.get("/api/database/maintenance/jobs/<job_id>")
    def job_status(job_id):
        with jobs_lock:
            job = jobs.get(job_id)
            return (jsonify(dict(job)), 200) if job else (jsonify({"error": "Maintenance job not found"}), 404)

    @app.get("/api/database/archive-files")
    def archive_files():
        return jsonify({"directory": str(archive_directory()), "archives": list_archive_files()})

    @app.get("/api/database/archive-files/<file_id>/download")
    def download_archive_file(file_id):
        try:
            path = archive_file_by_id(file_id)
            return send_file(path, as_attachment=True, download_name=path.name, mimetype="application/zip")
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/database/archive-files/<file_id>/<action>")
    def manage_archive_file(file_id, action):
        actions = {"restore": restore_archive_file_by_id, "delete": delete_archive_file_by_id}
        if action not in actions:
            return jsonify({"error": "Unknown archive file action"}), 404
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or data.get("confirm") is not True:
            return jsonify({"error": f"Confirm the archive file {action} operation"}), 400
        try:
            archive_file_by_id(file_id)
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return start_job(lambda progress: actions[action](file_id))

    @app.get("/api/games/<game_id>/archive")
    def preview_archive(game_id):
        if not GamesTable.get(game_id):
            return jsonify({"error": "Game not found"}), 404
        count = GameLinesTable._db.fetchone("SELECT COUNT(*) FROM game_lines WHERE game_id=?", (game_id,))[0]
        return jsonify({"raw_lines": count, **archive_summary(game_id)})

    @app.post("/api/games/<game_id>/archive")
    def archive(game_id):
        if not GamesTable.get(game_id):
            return jsonify({"error": "Game not found"}), 404
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or data.get("confirm") is not True:
            return jsonify({"error": "Confirm removal of the original sentences to archive this game"}), 400
        return start_job(lambda progress: archive_game(game_id))

    def selected_games(data):
        ids = data.get("game_ids") if isinstance(data, dict) else None
        if (
            not isinstance(ids, list)
            or not 1 <= len(ids) <= 1000
            or any(not isinstance(gid, str) or not gid.strip() or len(gid) > 512 for gid in ids)
        ):
            raise ValueError("Select between 1 and 1000 games using their game IDs")
        ids = list(dict.fromkeys(ids))
        games = {}
        for start in range(0, len(ids), 200):
            chunk = ids[start : start + 200]
            placeholders = ",".join("?" for _ in chunk)
            for gid, name, count in GameLinesTable._db.fetchall(
                f"""SELECT g.id, g.title_original, COUNT(gl.id) FROM games g
                    LEFT JOIN game_lines gl ON gl.game_id=g.id WHERE g.id IN ({placeholders}) GROUP BY g.id""",
                tuple(chunk),
            ):
                games[gid] = {"id": gid, "name": name or gid, "raw_lines": count}
        if len(games) != len(ids):
            raise ValueError("Some selected games no longer exist. Refresh the games list and try again.")
        return [games[gid] for gid in ids]

    @app.post("/api/games/archive/preview")
    def preview_batch_archive():
        try:
            games = selected_games(request.get_json(silent=True))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"game_count": len(games), "raw_lines": sum(g["raw_lines"] for g in games)})

    @app.post("/api/games/archive")
    def batch_archive():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or data.get("confirm") is not True:
            return jsonify({"error": "Confirm removal of the original sentences to archive these games"}), 400
        try:
            games = selected_games(data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        def archive_selected(progress):
            result = {
                "archived_games": 0,
                "archived_lines": 0,
                "skipped_games": 0,
                "successful_game_ids": [],
                "failed_games": [],
            }
            for index, game in enumerate(games):
                progress(total_games=len(games), completed_games=index, current_game=game["name"])
                try:
                    archived = archive_game(game["id"])
                    count = archived["archived_lines"]
                    result["archived_lines"] += count
                    result["archived_games"] += int(count > 0)
                    result["skipped_games"] += int(count == 0)
                    result["successful_game_ids"].append(game["id"])
                except Exception as exc:  # noqa: BLE001 - each game has its own archive transaction
                    logger.exception("Unable to archive game %s in batch", game["id"])
                    result["failed_games"].append({"game_id": game["id"], "game_name": game["name"], "error": str(exc)})
                progress(completed_games=index + 1, current_game=None, archived_lines=result["archived_lines"])
            return result

        return start_job(archive_selected)
