from __future__ import annotations

from typing import Any, Literal, TypedDict, TypeVar, Union

Operation = Literal["insert", "update", "delete", "upsert"]


class ChangeHeaders(TypedDict, total=False):
    operation: Operation
    txid: str
    timestamp: str
    # Allow arbitrary extension headers
    # (TypedDict can't express open dictionaries cleanly; callers can still pass)


T = TypeVar("T")


class ChangeEvent(TypedDict, total=False):
    type: str
    key: str
    value: T
    old_value: T
    headers: ChangeHeaders


class ControlHeaders(TypedDict, total=False):
    control: Literal["snapshot-start", "snapshot-end", "reset"]
    offset: str


class ControlEvent(TypedDict):
    headers: ControlHeaders


StateEvent = Union[ChangeEvent[Any], ControlEvent]


def is_change_event(event: StateEvent) -> bool:
    headers = event.get("headers")
    return isinstance(headers, dict) and "operation" in headers


def is_control_event(event: StateEvent) -> bool:
    headers = event.get("headers")
    return isinstance(headers, dict) and "control" in headers
