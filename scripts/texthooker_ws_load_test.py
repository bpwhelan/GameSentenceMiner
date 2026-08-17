"""Spin up many websocket clients against the texthooker feed and just receive text.

Usage:
    python scripts/texthooker_ws_load_test.py --clients 100
    python scripts/texthooker_ws_load_test.py --url ws://localhost:7275/ws/texthooker --clients 250 --quiet

Requires the `websockets` package (already a GSM dependency).
"""

from __future__ import annotations

import argparse
import asyncio
import time
from dataclasses import dataclass, field

import websockets


@dataclass
class Stats:
    connected: int = 0
    disconnected: int = 0
    failed: int = 0
    messages: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


async def run_client(client_id: int, url: str, stats: Stats, args: argparse.Namespace) -> None:
    backoff = args.reconnect_delay
    while True:
        try:
            async with websockets.connect(url, open_timeout=args.connect_timeout) as ws:
                async with stats.lock:
                    stats.connected += 1
                backoff = args.reconnect_delay
                async for message in ws:
                    async with stats.lock:
                        stats.messages += 1
                    if not args.quiet:
                        preview = message if len(message) <= 200 else f"{message[:200]}..."
                        print(f"[client {client_id:04d}] {preview}")
        except (websockets.exceptions.WebSocketException, OSError, asyncio.TimeoutError) as error:
            async with stats.lock:
                stats.failed += 1
                stats.connected = max(0, stats.connected - 1)
            if args.verbose:
                print(f"[client {client_id:04d}] connection error: {error}")
        else:
            async with stats.lock:
                stats.connected = max(0, stats.connected - 1)
                stats.disconnected += 1

        if not args.reconnect:
            return

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, args.max_reconnect_delay)


async def report_stats(stats: Stats, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        async with stats.lock:
            print(
                f"-- stats: connected={stats.connected} disconnected={stats.disconnected} "
                f"failed={stats.failed} messages_received={stats.messages} --"
            )


async def main_async(args: argparse.Namespace) -> None:
    stats = Stats()
    tasks = []

    reporter = asyncio.create_task(report_stats(stats, args.report_interval))

    for client_id in range(args.clients):
        tasks.append(asyncio.create_task(run_client(client_id, args.url, stats, args)))
        if args.ramp_delay > 0:
            await asyncio.sleep(args.ramp_delay)

    try:
        if args.duration > 0:
            await asyncio.sleep(args.duration)
        else:
            await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    finally:
        reporter.cancel()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with stats.lock:
            print(
                f"== final stats: connected={stats.connected} disconnected={stats.disconnected} "
                f"failed={stats.failed} messages_received={stats.messages} =="
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load-test the GSM texthooker websocket with many read-only clients.")
    parser.add_argument("--url", default="ws://localhost:7275/ws/texthooker", help="Websocket URL to connect to.")
    parser.add_argument("--clients", type=int, default=100, help="Number of concurrent clients to spawn.")
    parser.add_argument(
        "--ramp-delay", type=float, default=0.02, help="Seconds to wait between starting each client (ramp-up)."
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=0,
        help="Seconds to run before shutting down all clients (0 = run forever, Ctrl+C to stop).",
    )
    parser.add_argument(
        "--connect-timeout", type=float, default=10, help="Timeout in seconds for the initial connection."
    )
    parser.add_argument("--reconnect", action="store_true", help="Reconnect clients automatically if disconnected.")
    parser.add_argument(
        "--reconnect-delay", type=float, default=1.0, help="Initial delay in seconds before reconnecting."
    )
    parser.add_argument(
        "--max-reconnect-delay",
        type=float,
        default=30.0,
        help="Max backoff delay in seconds between reconnect attempts.",
    )
    parser.add_argument("--report-interval", type=float, default=5.0, help="Seconds between printed stats summaries.")
    parser.add_argument("--quiet", action="store_true", help="Do not print each received message, just count them.")
    parser.add_argument("--verbose", action="store_true", help="Print connection errors as they happen.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
