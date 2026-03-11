"""
Unit test verifying that the /api/mining_heatmap endpoint passes for_stats=True
to get_lines_filtered_by_timestamp, avoiding loading full line_text for every row.

Requirements: 4.1, 4.2
"""

from __future__ import annotations

from unittest.mock import patch

import flask
import pytest

from GameSentenceMiner.web.stats_api import register_stats_api_routes


@pytest.fixture()
def app():
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


class TestMiningHeatmapForStats:
    """Verify /api/mining_heatmap passes for_stats=True to avoid loading full line text."""

    @patch("GameSentenceMiner.web.stats_api.GameLinesTable.get_lines_filtered_by_timestamp")
    def test_for_stats_true_with_timestamps(self, mock_get_lines, client):
        """When called with start/end params, for_stats=True must be passed."""
        mock_get_lines.return_value = []

        client.get("/api/mining_heatmap?start=1700000000&end=1700100000")

        mock_get_lines.assert_called_once()
        _, kwargs = mock_get_lines.call_args
        assert kwargs.get("for_stats") is True, (
            "get_lines_filtered_by_timestamp must be called with for_stats=True"
        )

    @patch("GameSentenceMiner.web.stats_api.GameLinesTable.get_lines_filtered_by_timestamp")
    def test_for_stats_true_without_timestamps(self, mock_get_lines, client):
        """When called without timestamp params, for_stats=True must still be passed."""
        mock_get_lines.return_value = []

        client.get("/api/mining_heatmap")

        mock_get_lines.assert_called_once()
        _, kwargs = mock_get_lines.call_args
        assert kwargs.get("for_stats") is True, (
            "get_lines_filtered_by_timestamp must be called with for_stats=True even without timestamps"
        )
