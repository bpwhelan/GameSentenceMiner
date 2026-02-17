# import time

# from GameSentenceMiner.util.cloud_sync import cloud_sync_service
# from GameSentenceMiner.util.config.configuration import get_config
# from GameSentenceMiner.util.database.db import GameLinesTable


# def _reset_tables() -> None:
#     GameLinesTable._db.execute(
#         f"DELETE FROM {GameLinesTable._table}",
#         commit=True,
#     )
#     GameLinesTable._db.execute(
#         f"DELETE FROM {GameLinesTable._sync_changes_table}",
#         commit=True,
#     )
#     try:
#         GameLinesTable._db.execute("DELETE FROM sync_client_state", commit=True)
#     except Exception:
#         pass


# def _set_cloud_sync_config(
#     enabled: bool,
#     auto_sync: bool = False,
#     api_url: str = "",
#     email: str = "",
# ) -> None:
#     cfg = get_config().advanced
#     cfg.cloud_sync_enabled = enabled
#     cfg.cloud_sync_auto_sync = auto_sync
#     cfg.cloud_sync_api_url = api_url
#     cfg.cloud_sync_email = email
#     cfg.cloud_sync_api_token = ""
#     cfg.cloud_sync_device_id = "test-device"
#     cfg.cloud_sync_interval_seconds = 900
#     cfg.cloud_sync_push_batch_size = 500
#     cfg.cloud_sync_max_server_changes = 500
#     cfg.cloud_sync_timeout_seconds = 20


# def test_manual_sync_skips_when_disabled() -> None:
#     _reset_tables()
#     _set_cloud_sync_config(enabled=False)

#     result = cloud_sync_service.sync_once(manual=True)
#     assert result["status"] == "skipped"
#     assert "disabled" in result["reason"]


# def test_manual_sync_sends_and_acks_changes(monkeypatch) -> None:
#     _reset_tables()
#     _set_cloud_sync_config(
#         enabled=True,
#         api_url="https://sync.example.test",
#         email="tester@example.com",
#     )

#     GameLinesTable(
#         id="cloud_sync_line_1",
#         game_name="Cloud Game",
#         line_text="Line to sync",
#         timestamp=time.time(),
#     ).add()

#     captured_payloads = []

#     class _MockResponse:
#         status_code = 200
#         text = "ok"

#         @staticmethod
#         def json():
#             return {
#                 "message": "Gameline sync complete",
#                 "applied_client_changes": 1,
#                 "ignored_client_changes": 0,
#                 "server_changes": [],
#                 "next_since_seq": 7,
#                 "has_more": False,
#                 "server_time": time.time(),
#             }

#     def _mock_post(url, json, headers, timeout):
#         captured_payloads.append(
#             {
#                 "url": url,
#                 "payload": json,
#                 "headers": headers,
#                 "timeout": timeout,
#             }
#         )
#         return _MockResponse()

#     monkeypatch.setattr("GameSentenceMiner.util.cloud_sync.service.requests.post", _mock_post)

#     result = cloud_sync_service.sync_once(manual=True, include_existing=False, max_rounds=1)
#     assert result["status"] == "success"
#     assert result["sent_changes"] == 1
#     assert result["acked_changes"] == 1
#     assert result["pending_changes_after"] == 0
#     assert result["since_seq"] == 7

#     assert len(captured_payloads) == 1
#     payload = captured_payloads[0]["payload"]
#     assert payload["email"] == "tester@example.com"
#     assert payload["changes"][0]["id"] == "cloud_sync_line_1"
#     assert payload["changes"][0]["data"]["language"] == get_config().general.target_language
