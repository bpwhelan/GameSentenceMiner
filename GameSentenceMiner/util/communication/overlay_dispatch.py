from __future__ import annotations

import concurrent.futures
from dataclasses import dataclass
from typing import Any

from GameSentenceMiner.util.concurrency.actor import Actor, MailboxFull, MailboxPolicy
from GameSentenceMiner.util.concurrency.resource_qos import ExecutionClass
from GameSentenceMiner.util.concurrency.transport import submit_coroutine_to_loop


@dataclass(frozen=True)
class OverlayCommand:
    record: Any | None = None
    line: Any | None = None
    source: Any | None = None


class OverlayActor(Actor[OverlayCommand, None]):
    """Latest-wins owner for provisional overlay OCR/render work."""

    def __init__(self) -> None:
        super().__init__(
            "gsm-overlay-actor",
            capacity=1,
            policy=MailboxPolicy.LATEST,
            execution_class=ExecutionClass.LATENCY,
        )
        self._in_flight: concurrent.futures.Future[Any] | None = None
        self._pending: OverlayCommand | None = None

    def handle(self, message: OverlayCommand) -> None:
        self._pending = message
        self._dispatch_pending()

    def on_idle(self) -> None:
        # Overlay initialization can finish just after the first text event. Keep
        # the latest visual command until the processor is ready instead of
        # silently losing that line during startup.
        self._dispatch_pending()

    def _dispatch_pending(self) -> None:
        from GameSentenceMiner.util.config.configuration import logger
        from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor
        from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

        message = self._pending
        if message is None:
            return
        record = message.record
        if record is not None and record.skip_overlay:
            self._pending = None
            return
        # The overlay socket commonly connects just after the text pipeline.
        # Retain the single latest command until that readiness boundary closes.
        if not websocket_manager.has_clients(ID_OVERLAY):
            return
        overlay_processor = get_overlay_processor()
        if not overlay_processor.ready:
            return
        # The processor's coroutine still uses this generation to reject work
        # superseded between submission and loop execution. The actor is the sole
        # writer for text-triggered generations.
        overlay_processor._current_sequence += 1
        sequence = overlay_processor._current_sequence
        future = submit_coroutine_to_loop(
            overlay_processor.processing_loop,
            overlay_processor.find_box_and_send_to_overlay(
                message.line,
                dict_from_ocr=(record.metadata.get("dict_from_ocr") if record is not None else None),
                sequence=sequence,
                source=message.source,
            ),
        )
        self._pending = None
        self._in_flight = future

        def report_failure(completed: concurrent.futures.Future[Any]) -> None:
            try:
                completed.result()
            except concurrent.futures.CancelledError:
                pass
            except Exception as error:
                # Overlay work is visual and coalescing; its failure is reported but
                # does not invalidate the authoritative text stream.
                logger.debug(f"Overlay projection failed: {error}")

        future.add_done_callback(report_failure)

    def on_stop(self) -> None:
        self._pending = None
        future = self._in_flight
        if future is not None and not future.done():
            future.cancel()


class OverlayDispatcher:
    def __init__(self) -> None:
        self.actor = OverlayActor()
        self.actor.start()

    def submit(self, command: OverlayCommand) -> bool:
        try:
            self.actor.ref.tell(command, timeout=0)
            return True
        except MailboxFull:
            return False

    def stop(self) -> bool:
        return self.actor.stop(drain=False, timeout=3)

    def health_snapshot(self) -> dict[str, object]:
        metrics = self.actor.metrics_snapshot()
        return {
            "alive": self.actor.is_alive,
            "capacity": self.actor.capacity,
            "policy": self.actor.policy.value,
            **metrics.__dict__,
        }
