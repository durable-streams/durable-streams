from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from durable_streams import AsyncDurableStream, DurableStream

from durable_streams_state.schema import CollectionSchema, StateSchema
from durable_streams_state.types import StateEvent, is_change_event, is_control_event

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class CollectionChange:
    key: str
    type: str  # insert | update | delete
    value: Any | None = None
    previous_value: Any | None = None


class _Subscription:
    def __init__(self, *, unsubscribe: Callable[[], None]) -> None:
        self._unsubscribe = unsubscribe
        self._active = True

    def unsubscribe(self) -> None:
        if self._active:
            self._active = False
            self._unsubscribe()


class CollectionView(Generic[T]):
    def __init__(self, *, name: str, schema: CollectionSchema[T]) -> None:
        self.name = name
        self.schema = schema
        self._data: dict[str, T] = {}
        self._subscribers: list[Callable[[list[CollectionChange]], None]] = []

        # Track keys for upsert -> insert/update conversion
        self._known_keys: set[str] = set()

        # Pending operations until commit
        self._pending: list[CollectionChange] = []

    @property
    def size(self) -> int:
        return len(self._data)

    def get(self, key: str) -> T | None:
        return self._data.get(key)

    def values(self) -> list[T]:
        return list(self._data.values())

    def items(self) -> list[tuple[str, T]]:
        return list(self._data.items())

    def subscribe_changes(
        self, cb: Callable[[list[CollectionChange]], None]
    ) -> _Subscription:
        self._subscribers.append(cb)

        def _unsub() -> None:
            try:
                self._subscribers.remove(cb)
            except ValueError:
                return

        return _Subscription(unsubscribe=_unsub)

    def _truncate(self) -> None:
        self._data.clear()
        self._known_keys.clear()
        self._pending.clear()

    def _stage_change(self, change: CollectionChange) -> None:
        self._pending.append(change)

    def _commit(self) -> None:
        if not self._pending:
            return

        # Apply pending in order
        applied: list[CollectionChange] = []
        for ch in self._pending:
            if ch.type == "insert" or ch.type == "update":
                if ch.value is not None:
                    self._data[ch.key] = ch.value  # type: ignore[assignment]
                    self._known_keys.add(ch.key)
            elif ch.type == "delete":
                self._data.pop(ch.key, None)
                self._known_keys.discard(ch.key)

            applied.append(ch)

        self._pending.clear()

        if self._subscribers:
            for cb in list(self._subscribers):
                cb(applied)


class _TxIdWaiter:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._error: Exception | None = None

    def resolve(self) -> None:
        self._event.set()

    def reject(self, err: Exception) -> None:
        self._error = err
        self._event.set()

    def wait(self, timeout: float | None) -> None:
        ok = self._event.wait(timeout)
        if not ok:
            raise TimeoutError("Timeout waiting for txid")
        if self._error is not None:
            raise self._error


class _Dispatcher:
    def __init__(self, *, schema: StateSchema) -> None:
        self._type_to_collection: dict[str, CollectionView[Any]] = {}
        self._collections: dict[str, CollectionView[Any]] = {}

        for name, cs in schema.items():
            view = CollectionView(name=name, schema=cs)
            self._collections[name] = view
            self._type_to_collection[cs.type] = view

        self._ready = False

        # txid tracking
        self._seen_txids: set[str] = set()
        self._pending_txids: set[str] = set()
        self._txid_waiters: dict[str, list[_TxIdWaiter]] = {}

        # Buffer changes until commit boundary (up_to_date)
        self._pending_any = False

    @property
    def collections(self) -> Mapping[str, CollectionView[Any]]:
        return self._collections

    @property
    def ready(self) -> bool:
        return self._ready

    def dispatch_change(self, event: StateEvent) -> None:
        if not is_change_event(event):
            return

        headers = event.get("headers") or {}
        txid = headers.get("txid")
        if isinstance(txid, str) and txid:
            self._pending_txids.add(txid)

        event_type = event.get("type")
        key = event.get("key")
        if not isinstance(event_type, str) or not isinstance(key, str):
            return

        view = self._type_to_collection.get(event_type)
        if view is None:
            # unknown type: ignore
            return

        op = headers.get("operation")
        if op not in ("insert", "update", "delete", "upsert"):
            return

        # Enforce object-ish values (needed for primary_key injection)
        if op != "delete":
            value = event.get("value")
            if not isinstance(value, dict):
                raise ValueError(
                    f"StreamDB collections require object values; got {type(value).__name__} "
                    f"for type={event_type}, key={key}"
                )
            validated = view.schema.validate_incoming(value, key=key)

            # Convert upsert to insert/update
            actual_op = op
            if op == "upsert":
                actual_op = "update" if key in view._known_keys else "insert"

            prev = view.get(key)
            view._stage_change(
                CollectionChange(
                    key=key,
                    type=actual_op,
                    value=validated,
                    previous_value=prev if actual_op == "update" else None,
                )
            )
            self._pending_any = True
            return

        # delete
        prev = view.get(key)
        view._stage_change(
            CollectionChange(key=key, type="delete", value=prev, previous_value=None)
        )
        self._pending_any = True

    def dispatch_control(self, event: StateEvent) -> None:
        if not is_control_event(event):
            return

        headers = event.get("headers") or {}
        ctrl = headers.get("control")
        if ctrl == "reset":
            for v in self._collections.values():
                v._truncate()
            self._pending_txids.clear()
            self._pending_any = False
            self._ready = False

    def commit_if_up_to_date(self, *, up_to_date: bool) -> None:
        if not up_to_date:
            return

        # Commit pending changes
        if self._pending_any:
            for v in self._collections.values():
                v._commit()
            self._pending_any = False

        # Resolve pending txids
        if self._pending_txids:
            for txid in list(self._pending_txids):
                self._seen_txids.add(txid)
                waiters = self._txid_waiters.pop(txid, None)
                if waiters:
                    for w in waiters:
                        w.resolve()
            self._pending_txids.clear()

        if not self._ready:
            self._ready = True

    def await_txid(self, txid: str, timeout: float = 5.0) -> None:
        if txid in self._seen_txids:
            return

        waiter = _TxIdWaiter()
        self._txid_waiters.setdefault(txid, []).append(waiter)
        waiter.wait(timeout)

    def reject_all(self, err: Exception) -> None:
        # Reject all txid waiters
        for waiters in self._txid_waiters.values():
            for w in waiters:
                w.reject(err)
        self._txid_waiters.clear()


class StreamDB:
    """Sync StreamDB that materializes a JSON state stream into collections."""

    def __init__(
        self,
        *,
        stream: DurableStream,
        state: StateSchema,
        live: Any = "auto",
    ) -> None:
        self.stream = stream
        self._dispatcher = _Dispatcher(schema=state)
        self.collections = self._dispatcher.collections
        self._live = live

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._error: Exception | None = None
        self._response: Any | None = None

    def _run(self) -> None:
        try:
            with self.stream.stream(live=self._live) as res:
                self._response = res
                had_batches = False
                for batch in res.iter_json_batches():
                    had_batches = True
                    if self._stop.is_set():
                        break

                    for item in batch:
                        if not isinstance(item, dict):
                            continue
                        event: StateEvent = item  # type: ignore[assignment]
                        if is_change_event(event):
                            self._dispatcher.dispatch_change(event)
                        elif is_control_event(event):
                            self._dispatcher.dispatch_control(event)

                    self._dispatcher.commit_if_up_to_date(
                        up_to_date=bool(res.up_to_date)
                    )
                    if self._dispatcher.ready:
                        self._ready.set()

                    if self._stop.is_set():
                        break

                    # Keep loop responsive even if stream is very quiet
                    # (iter_json_batches already blocks; this is just a yield point)
                    time.sleep(0)

                # Handle empty streams (no batches received) - mark as ready
                if not had_batches:
                    self._dispatcher.commit_if_up_to_date(up_to_date=True)
                    self._ready.set()
        except Exception as e:
            self._error = e
            self._dispatcher.reject_all(e)
            self._ready.set()
        finally:
            self._response = None

    def preload(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

        self._ready.wait()
        if self._error is not None:
            raise self._error

    def close(self) -> None:
        self._stop.set()
        if self._response is not None:
            with contextlib.suppress(Exception):
                self._response.close()

    @property
    def utils(self) -> Any:
        class _Utils:
            def __init__(self, outer: StreamDB) -> None:
                self._outer = outer

            def await_txid(self, txid: str, timeout: float = 5.0) -> None:
                return self._outer._dispatcher.await_txid(txid, timeout)

        return _Utils(self)


class AsyncStreamDB:
    """Async StreamDB that materializes a JSON state stream into collections."""

    def __init__(
        self,
        *,
        stream: AsyncDurableStream,
        state: StateSchema,
        live: Any = "auto",
    ) -> None:
        self.stream = stream
        self._dispatcher = _Dispatcher(schema=state)
        self.collections = self._dispatcher.collections
        self._live = live

        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._error: Exception | None = None
        self._response: Any | None = None

    async def _run(self) -> None:
        try:
            async with self.stream.stream(live=self._live) as res:
                self._response = res
                had_batches = False
                async for batch in res.iter_json_batches():
                    had_batches = True
                    for item in batch:
                        if not isinstance(item, dict):
                            continue
                        event: StateEvent = item  # type: ignore[assignment]
                        if is_change_event(event):
                            self._dispatcher.dispatch_change(event)
                        elif is_control_event(event):
                            self._dispatcher.dispatch_control(event)

                    self._dispatcher.commit_if_up_to_date(
                        up_to_date=bool(res.up_to_date)
                    )
                    if self._dispatcher.ready:
                        self._ready.set()

                    await asyncio.sleep(0)

                # Handle empty streams (no batches received) - mark as ready
                if not had_batches:
                    self._dispatcher.commit_if_up_to_date(up_to_date=True)
                    self._ready.set()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._error = e
            self._dispatcher.reject_all(e)
            self._ready.set()
        finally:
            self._response = None

    async def preload(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

        await self._ready.wait()
        if self._error is not None:
            raise self._error

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

        if self._response is not None:
            with contextlib.suppress(Exception):
                await self._response.aclose()

    @property
    def utils(self) -> Any:
        class _Utils:
            def __init__(self, outer: AsyncStreamDB) -> None:
                self._outer = outer

            async def await_txid(self, txid: str, timeout: float = 5.0) -> None:
                # Reuse sync waiter with polling (simple + shared core)
                start = time.time()
                while True:
                    if txid in self._outer._dispatcher._seen_txids:  # noqa: SLF001
                        return
                    if time.time() - start > timeout:
                        raise TimeoutError("Timeout waiting for txid")
                    await asyncio.sleep(0.01)

        return _Utils(self)


def create_stream_db(
    *,
    stream: DurableStream,
    state: StateSchema,
    live: Any = "auto",
) -> StreamDB:
    return StreamDB(stream=stream, state=state, live=live)


def create_async_stream_db(
    *,
    stream: AsyncDurableStream,
    state: StateSchema,
    live: Any = "auto",
) -> AsyncStreamDB:
    return AsyncStreamDB(stream=stream, state=state, live=live)
