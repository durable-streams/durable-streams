from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from durable_streams_state.types import ChangeEvent


class MaterializedState:
    """A simple in-memory materializer for ChangeEvents.

    Matches `packages/state`'s `MaterializedState`: state is grouped by `type`,
    each type is a map of `key -> value`.

    This is intentionally schema-agnostic and supports primitive values.
    """

    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}

    def apply(self, event: ChangeEvent[Any]) -> None:
        event_type = event.get("type")
        key = event.get("key")
        headers = event.get("headers") or {}
        op = headers.get("operation")

        if not event_type or not key or not op:
            # Ignore malformed events
            return

        type_map = self._data.setdefault(event_type, {})

        if op in ("insert", "update", "upsert"):
            type_map[key] = event.get("value")
        elif op == "delete":
            type_map.pop(key, None)

    def apply_batch(self, events: Iterable[ChangeEvent[Any]]) -> None:
        for event in events:
            self.apply(event)

    def get(self, type_: str, key: str) -> Any | None:
        return self._data.get(type_, {}).get(key)

    def get_type(self, type_: str) -> dict[str, Any]:
        # Return a shallow copy to avoid accidental external mutation
        return dict(self._data.get(type_, {}))

    def clear(self) -> None:
        self._data.clear()

    @property
    def type_count(self) -> int:
        return len(self._data)

    @property
    def types(self) -> list[str]:
        return list(self._data.keys())
