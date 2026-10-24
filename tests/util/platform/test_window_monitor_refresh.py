import asyncio

from GameSentenceMiner.util.platform.base_window_monitor import BaseWindowStateMonitor


def test_refresh_wakes_monitor_from_websocket_thread():
    async def scenario():
        monitor = BaseWindowStateMonitor()
        waiter = asyncio.create_task(monitor.wait_for_refresh(10))
        await asyncio.sleep(0.001)
        try:
            await asyncio.to_thread(monitor.request_refresh)
            await asyncio.wait_for(waiter, 0.2)
            assert monitor._refresh_generation == 1
            assert not monitor._refresh_requested.is_set()
        finally:
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)

    asyncio.run(scenario(), debug=True)


def test_refresh_before_wait_is_not_lost_and_idle_wait_times_out():
    async def scenario():
        monitor = BaseWindowStateMonitor()
        monitor.request_refresh()
        await asyncio.wait_for(monitor.wait_for_refresh(10), 0.2)
        await asyncio.wait_for(monitor.wait_for_refresh(0.001), 0.2)
        assert monitor._refresh_generation == 1

    asyncio.run(scenario())
