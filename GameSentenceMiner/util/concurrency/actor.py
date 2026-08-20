from __future__ import annotations

import queue
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Callable, Generic, TypeVar, cast

from .resource_qos import ExecutionClass, configure_current_thread

MessageT = TypeVar("MessageT")
ResultT = TypeVar("ResultT")


class MailboxPolicy(Enum):
    ORDERED = "ordered"
    LATEST = "latest"


class MailboxFull(RuntimeError):
    pass


class ActorStopped(RuntimeError):
    pass


@dataclass(frozen=True)
class ActorMetrics:
    accepted: int = 0
    processed: int = 0
    failed: int = 0
    rejected: int = 0
    coalesced: int = 0
    high_watermark: int = 0
    oldest_item_age_ms: float = 0.0


@dataclass
class _MutableActorMetrics:
    accepted: int = 0
    processed: int = 0
    failed: int = 0
    rejected: int = 0
    coalesced: int = 0
    high_watermark: int = 0


@dataclass(frozen=True)
class _Envelope(Generic[MessageT, ResultT]):
    message: MessageT
    correlation_id: str
    enqueued_monotonic: float
    response: Future[ResultT] | None = None


_STOP = object()


class ActorRef(Generic[MessageT, ResultT]):
    def __init__(self, actor: "Actor[MessageT, ResultT]") -> None:
        self._actor = actor

    def tell(self, message: MessageT, *, timeout: float = 0.25) -> str:
        return self._actor._enqueue(message, timeout=timeout)

    def ask(self, message: MessageT, *, timeout: float = 0.25) -> ResultT:
        future: Future[ResultT] = Future()
        self._actor._enqueue(message, timeout=timeout, response=future)
        return future.result(timeout=timeout)


class Actor(Generic[MessageT, ResultT]):
    """A single-owner state machine backed by a bounded, typed mailbox."""

    def __init__(
        self,
        name: str,
        *,
        capacity: int,
        policy: MailboxPolicy = MailboxPolicy.ORDERED,
        idle_poll_seconds: float = 0.05,
        execution_class: ExecutionClass = ExecutionClass.NORMAL,
    ) -> None:
        if capacity <= 0:
            raise ValueError("Actor mailbox capacity must be positive")
        self.name = name
        self.capacity = capacity
        self.policy = policy
        self._idle_poll_seconds = idle_poll_seconds
        self.execution_class = execution_class
        self._mailbox: queue.Queue[object] = queue.Queue(maxsize=capacity)
        self._thread: threading.Thread | None = None
        self._accepting = True
        self._started = threading.Event()
        self._stopped = threading.Event()
        self._metrics = _MutableActorMetrics()
        self._metrics_lock = threading.Lock()
        self._failure_handler: Callable[["Actor[MessageT, ResultT]", BaseException], None] | None = None
        self.ref: ActorRef[MessageT, ResultT] = ActorRef(self)

    @property
    def thread_name(self) -> str:
        return self._thread.name if self._thread else self.name

    @property
    def is_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self.is_alive:
            return
        if self._stopped.is_set():
            raise ActorStopped(f"Actor '{self.name}' cannot be restarted")
        self._thread = threading.Thread(target=self._run, name=self.name, daemon=False)
        self._thread.start()
        if not self._started.wait(1):
            raise RuntimeError(f"Actor '{self.name}' failed to start")

    def handle(self, message: MessageT) -> ResultT:
        raise NotImplementedError

    def on_start(self) -> None:
        pass

    def on_idle(self) -> None:
        pass

    def on_stop(self) -> None:
        pass

    def _enqueue(
        self,
        message: MessageT,
        *,
        timeout: float,
        response: Future[ResultT] | None = None,
    ) -> str:
        if not self._accepting or self._stopped.is_set():
            raise ActorStopped(f"Actor '{self.name}' is stopped")
        correlation_id = str(uuid.uuid4())
        envelope: _Envelope[MessageT, ResultT] = _Envelope(
            message=message,
            correlation_id=correlation_id,
            enqueued_monotonic=time.monotonic(),
            response=response,
        )
        if self.policy is MailboxPolicy.LATEST:
            self._enqueue_latest(envelope)
        else:
            try:
                self._mailbox.put(envelope, timeout=max(0.0, timeout))
            except queue.Full as exc:
                with self._metrics_lock:
                    self._metrics.rejected += 1
                raise MailboxFull(f"Actor '{self.name}' mailbox is full") from exc
        with self._metrics_lock:
            self._metrics.accepted += 1
            self._metrics.high_watermark = max(self._metrics.high_watermark, self._mailbox.qsize())
        return correlation_id

    def _enqueue_latest(self, envelope: _Envelope[MessageT, ResultT]) -> None:
        while True:
            try:
                self._mailbox.put_nowait(envelope)
                return
            except queue.Full:
                try:
                    replaced = self._mailbox.get_nowait()
                except queue.Empty:
                    continue
                self._mailbox.task_done()
                if isinstance(replaced, _Envelope) and replaced.response is not None:
                    replaced.response.set_exception(MailboxFull(f"Actor '{self.name}' request was coalesced"))
                with self._metrics_lock:
                    self._metrics.coalesced += 1

    def _run(self) -> None:
        configure_current_thread(self.execution_class)
        self._started.set()
        try:
            self.on_start()
            while True:
                try:
                    item = self._mailbox.get(timeout=self._idle_poll_seconds)
                except queue.Empty:
                    self.on_idle()
                    continue
                if item is _STOP:
                    self._mailbox.task_done()
                    break
                envelope = cast(_Envelope[MessageT, ResultT], item)
                fatal_error = False
                try:
                    result = self.handle(envelope.message)
                except BaseException as exc:
                    fatal_error = True
                    with self._metrics_lock:
                        self._metrics.failed += 1
                    if envelope.response is not None:
                        envelope.response.set_exception(exc)
                    if self._failure_handler is not None:
                        self._failure_handler(self, exc)
                else:
                    with self._metrics_lock:
                        self._metrics.processed += 1
                    if envelope.response is not None:
                        envelope.response.set_result(result)
                finally:
                    self._mailbox.task_done()
                if fatal_error:
                    break
        finally:
            self._accepting = False
            while True:
                try:
                    pending = self._mailbox.get_nowait()
                except queue.Empty:
                    break
                self._mailbox.task_done()
                if isinstance(pending, _Envelope) and pending.response is not None:
                    pending.response.set_exception(ActorStopped(f"Actor '{self.name}' failed"))
            try:
                self.on_stop()
            finally:
                self._accepting = False
                self._stopped.set()

    def wait_idle(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._mailbox.unfinished_tasks == 0:
                return True
            time.sleep(0.005)
        return self._mailbox.unfinished_tasks == 0

    def stop(self, *, drain: bool = True, timeout: float = 10.0) -> bool:
        if self._stopped.is_set():
            return True
        self._accepting = False
        if not drain:
            while True:
                try:
                    item = self._mailbox.get_nowait()
                except queue.Empty:
                    break
                self._mailbox.task_done()
                if isinstance(item, _Envelope) and item.response is not None:
                    item.response.set_exception(ActorStopped(f"Actor '{self.name}' stopped"))
        if self._thread is None:
            self._stopped.set()
            return True
        deadline = time.monotonic() + max(0.0, timeout)
        if drain:
            self.wait_idle(max(0.0, deadline - time.monotonic()))
        try:
            self._mailbox.put(_STOP, timeout=min(max(0.0, deadline - time.monotonic()), 1.0))
        except queue.Full:
            return False
        if self._thread is not threading.current_thread():
            self._thread.join(max(0.0, deadline - time.monotonic()))
        return not self.is_alive

    def metrics_snapshot(self) -> ActorMetrics:
        with self._metrics_lock:
            values = asdict(self._metrics)
        oldest_age = 0.0
        with self._mailbox.mutex:
            for item in self._mailbox.queue:
                if isinstance(item, _Envelope):
                    oldest_age = max(0.0, (time.monotonic() - item.enqueued_monotonic) * 1000)
                    break
        return ActorMetrics(**values, oldest_item_age_ms=oldest_age)


class RuntimeSupervisor:
    def __init__(self) -> None:
        self._actors: list[Actor[object, object]] = []
        self._state = "created"
        self._failure: dict[str, str] | None = None
        self._lock = threading.RLock()

    def register(self, actor: Actor[MessageT, ResultT]) -> Actor[MessageT, ResultT]:
        with self._lock:
            if self._state != "created":
                raise RuntimeError("Actors must be registered before the supervisor starts")
            actor._failure_handler = self._actor_failed
            self._actors.append(cast(Actor[object, object], actor))
        return actor

    def start(self) -> None:
        with self._lock:
            if self._state == "running":
                return
            if self._state != "created":
                raise RuntimeError(f"Cannot start supervisor in state '{self._state}'")
            for actor in self._actors:
                actor.start()
            self._state = "running"

    def stop(self, *, drain_timeout: float = 5.0, join_timeout: float = 10.0) -> bool:
        with self._lock:
            if self._state == "stopped":
                return True
            self._state = "stopping"
            actors = list(reversed(self._actors))
        deadline = time.monotonic() + drain_timeout
        for actor in actors:
            actor.wait_idle(max(0.0, deadline - time.monotonic()))
        success = True
        for actor in actors:
            # Never short-circuit shutdown: every registered owner must receive
            # its stop request even if an earlier actor missed its deadline.
            success = actor.stop(drain=True, timeout=join_timeout) and success
        with self._lock:
            self._state = "stopped"
        return success

    def _actor_failed(self, actor: Actor[object, object], exc: BaseException) -> None:
        with self._lock:
            self._failure = {"actor": actor.name, "error": repr(exc)}
            self._state = "failed"
            # A state-owner failure closes all intake immediately. Shutdown can
            # then drain/stop the remaining owners in a controlled order.
            for registered in self._actors:
                registered._accepting = False

    def health_snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "state": self._state,
                "healthy": self._state == "running" and self._failure is None,
                "failure": dict(self._failure) if self._failure else None,
                "actors": {
                    actor.name: {
                        "alive": actor.is_alive,
                        "capacity": actor.capacity,
                        "policy": actor.policy.value,
                        **asdict(actor.metrics_snapshot()),
                    }
                    for actor in self._actors
                },
            }
