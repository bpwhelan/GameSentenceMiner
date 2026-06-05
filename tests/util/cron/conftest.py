import pytest


@pytest.fixture(autouse=True)
def _ensure_db_write_queue_running():
    from GameSentenceMiner.util.database.write_queue import db_write_queue

    db_write_queue.start()
    yield
