from types import SimpleNamespace

from GameSentenceMiner.util.clients import discord_rpc


def test_discord_rpc_actor_does_not_block_process_shutdown(monkeypatch):
    created_threads = []

    class FakeThread:
        def __init__(self, *, target, name, daemon):
            self.target = target
            self.name = name
            self.daemon = daemon
            self.started = False
            created_threads.append(self)

        def start(self):
            self.started = True

    monkeypatch.setattr(
        discord_rpc,
        "get_master_config",
        lambda: SimpleNamespace(discord=SimpleNamespace(enabled=True)),
    )
    monkeypatch.setattr(discord_rpc.threading, "Thread", FakeThread)

    manager = discord_rpc.DiscordRPCManager()
    manager.start()

    assert len(created_threads) == 1
    assert created_threads[0].name == "gsm-discord-actor"
    assert created_threads[0].daemon is True
    assert created_threads[0].started is True
