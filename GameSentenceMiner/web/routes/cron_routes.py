"""
Cron Routes

Routes for cron/background job operations:
- List scheduled tasks
- Trigger a task manually and wait for completion
- Keep the legacy Jiten upgrader endpoint working
"""

from flask import Blueprint, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.cron.run_crons import (
    cron_scheduler,
    create_forced_cron,
    get_supported_cron_names,
    resolve_cron_task,
)
from GameSentenceMiner.util.database.cron_table import CronTable

cron_bp = Blueprint("cron", __name__)


def _get_canonical_task_name(task_name: str) -> str:
    """Return the canonical cron task name for routing and dedupe decisions."""
    resolved_task = resolve_cron_task(task_name)
    if resolved_task:
        return resolved_task.value
    return (task_name or "").strip().lower()


def _get_task_lookup_names(task_name: str) -> list[str]:
    """Return exact names that may match a requested task."""
    candidate_names = []

    normalized_name = (task_name or "").strip().lower()
    resolved_task = resolve_cron_task(task_name)
    if resolved_task and resolved_task.value:
        candidate_names.append(resolved_task.value)

    if normalized_name and normalized_name not in candidate_names:
        candidate_names.append(normalized_name)

    return candidate_names


def _get_task_row(task_name: str):
    """Find the cron row backing a requested task, preferring canonical rows."""
    canonical_name = _get_canonical_task_name(task_name)
    candidate_rows = []

    for candidate_name in _get_task_lookup_names(task_name):
        task_row = CronTable.get_by_name(candidate_name)
        if task_row:
            candidate_rows.append(task_row)

    for task_row in candidate_rows:
        if task_row.name == canonical_name:
            return task_row

    return candidate_rows[0] if candidate_rows else None


def _select_preferred_tasks(tasks: list[dict]) -> list[dict]:
    """Collapse legacy aliases down to the canonical task card shown in the UI."""
    preferred_by_canonical_name: dict[str, dict] = {}

    for task in tasks:
        canonical_name = task["canonical_name"]
        existing = preferred_by_canonical_name.get(canonical_name)
        if existing is None:
            preferred_by_canonical_name[canonical_name] = task
            continue

        if task["name"] == canonical_name and existing["name"] != canonical_name:
            preferred_by_canonical_name[canonical_name] = task

    return list(preferred_by_canonical_name.values())


def _serialize_cron_row(task_row: CronTable) -> dict:
    """Serialize cron rows for the tasks API."""
    resolved_task = resolve_cron_task(task_row.name)
    schedule = task_row.schedule
    next_run = task_row.next_run

    # Legacy populate_games rows were stored as weekly, but they behave as one-off tasks.
    if resolved_task and resolved_task.value == "populate_games":
        schedule = "once"

    if schedule == "once" and not task_row.enabled:
        next_run = None

    canonical_name = resolved_task.value if resolved_task else task_row.name
    display_name = canonical_name.replace("_", " ").title()

    return {
        "id": task_row.id,
        "name": task_row.name,
        "display_name": display_name,
        "canonical_name": canonical_name,
        "description": task_row.description,
        "schedule": schedule,
        "enabled": task_row.enabled,
        "last_run": task_row.last_run,
        "next_run": next_run,
        "can_rerun": task_row.name in get_supported_cron_names() or resolved_task is not None,
    }


def _run_task_and_wait(task_name: str):
    """Execute a cron task synchronously, returning the detail payload and row."""
    task_row = _get_task_row(task_name)
    resolved_task = resolve_cron_task(task_name if task_row is None else task_row.name)

    if resolved_task is None:
        return None, None

    if task_row is None:
        task_row = create_forced_cron(resolved_task)

    result = cron_scheduler.run_cron_blocking(task_row)
    detail = result.get("details", [{}])[0] if result.get("details") else None

    refreshed_row = None
    if getattr(task_row, "id", -1) != -1:
        refreshed_row = CronTable.get(task_row.id)

    return detail, refreshed_row


@cron_bp.route("/api/cron/tasks", methods=["GET"])
def api_list_cron_tasks():
    """Return all cron rows for the tools/tasks tab."""
    serialized_tasks = _select_preferred_tasks([_serialize_cron_row(task) for task in CronTable.all()])
    tasks = sorted(
        serialized_tasks,
        key=lambda task: (
            task["next_run"] is None,
            task["next_run"] if task["next_run"] is not None else float("inf"),
            task["name"],
        ),
    )

    return jsonify({"tasks": tasks}), 200


@cron_bp.route("/api/cron/tasks/<task_name>/run", methods=["POST"])
def api_run_cron_task(task_name: str):
    """Manually run a cron task and wait for the result."""
    try:
        detail, refreshed_row = _run_task_and_wait(task_name)

        if detail is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": f"Unknown cron task: {task_name}",
                    }
                ),
                404,
            )

        if not detail.get("success"):
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": detail.get("error") or "Cron task failed",
                        "execution": detail,
                        "task": _serialize_cron_row(refreshed_row) if refreshed_row else None,
                    }
                ),
                500,
            )

        return (
            jsonify(
                {
                    "status": "success",
                    "execution": detail,
                    "task": _serialize_cron_row(refreshed_row) if refreshed_row else None,
                }
            ),
            200,
        )

    except TimeoutError as e:
        logger.exception(f"Timed out running cron task {task_name}: {e}")
        return jsonify({"status": "error", "error": str(e)}), 504
    except Exception as e:
        logger.exception(f"Error running cron task {task_name}: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


@cron_bp.route("/api/cron/jiten-upgrader/run", methods=["POST"])
def api_run_jiten_upgrader():
    """
    Manually trigger the Jiten Upgrader cron job.

    This endpoint checks all games with vndb_id or anilist_id (but no deck_id)
    to see if Jiten.moe now has entries for them, and auto-links if found.
    """
    try:
        detail, _ = _run_task_and_wait("jiten_upgrader")

        if detail is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": "Jiten Upgrader task is not available",
                    }
                ),
                404,
            )

        if not detail.get("success"):
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": detail.get("error") or "Failed to run Jiten Upgrader",
                    }
                ),
                500,
            )

        result = detail.get("result", {})
        return (
            jsonify(
                {
                    "status": "success",
                    "result": {
                        "total_checked": result.get("total_checked", 0),
                        "upgraded_to_jiten": result.get("upgraded_to_jiten", 0),
                        "already_on_jiten": result.get("already_on_jiten", 0),
                        "not_found_on_jiten": result.get("not_found_on_jiten", 0),
                        "failed": result.get("failed", 0),
                        "elapsed_time": result.get("elapsed_time", 0),
                        "details": result.get("details", []),
                    },
                }
            ),
            200,
        )

    except Exception as e:
        logger.exception(f"Error running Jiten Upgrader: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500
