from __future__ import annotations

from flask import current_app, jsonify, request, send_file

from GameSentenceMiner.web.export import list_stats_exporters
from GameSentenceMiner.web.export.service import stats_export_job_manager


def register_stats_export_api_routes(app):
    @app.route("/api/stats-export/formats", methods=["GET"])
    def api_stats_export_formats():
        return jsonify({"formats": [exporter.metadata() for exporter in list_stats_exporters()]}), 200

    @app.route("/api/stats-export/jobs", methods=["POST"])
    def api_stats_export_create_job():
        data = request.get_json(silent=True) or {}
        format_key = str(data.get("format") or "").strip()
        scope = str(data.get("scope") or "all_time").strip().lower()

        try:
            payload = stats_export_job_manager.start_job(
                format_key,
                {
                    "scope": scope,
                    "start_date": data.get("start_date"),
                    "end_date": data.get("end_date"),
                    "include_external_stats": bool(data.get("include_external_stats", True)),
                },
                run_inline=bool(current_app.testing),
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify(payload), 202

    @app.route("/api/stats-export/jobs/<job_id>", methods=["GET"])
    def api_stats_export_job_status(job_id: str):
        payload = stats_export_job_manager.get_job(job_id)
        if payload is None:
            return jsonify({"error": "Export job not found"}), 404
        return jsonify(payload), 200

    @app.route("/api/stats-export/jobs/<job_id>/download", methods=["GET"])
    def api_stats_export_download(job_id: str):
        result = stats_export_job_manager.get_job_file(job_id)
        if result is None:
            return jsonify({"error": "Export file is not ready"}), 409

        file_path, filename = result
        return send_file(
            file_path,
            as_attachment=True,
            download_name=filename,
            mimetype="text/csv",
            conditional=True,
        )
