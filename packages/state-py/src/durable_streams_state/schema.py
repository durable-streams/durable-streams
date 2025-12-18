from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, TypeAdapter

from durable_streams_state.types import ChangeEvent

T = TypeVar("T")


_RESERVED_COLLECTION_NAMES = {
    "collections",
    "preload",
    "close",
    "aclose",
    "utils",
    "actions",
}


@dataclass(frozen=True, slots=True)
class CollectionDefinition(Generic[T]):
    """Definition for a single collection in a state stream."""

    model: type[T] | TypeAdapter[T]
    type: str
    primary_key: str


class CollectionSchema(Generic[T]):
    """Schema + event helper methods for a collection."""

    def __init__(self, *, definition: CollectionDefinition[T]) -> None:
        self.definition = definition
        self.type = definition.type
        self.primary_key = definition.primary_key
        self._adapter: TypeAdapter[T] = (
            definition.model
            if isinstance(definition.model, TypeAdapter)
            else TypeAdapter(definition.model)
        )

    def _validate(self, value: Any, *, label: str) -> T:
        try:
            return self._adapter.validate_python(value)
        except Exception as e:  # pragma: no cover
            raise ValueError(f"Validation failed for {self.type} {label}: {e}")

    def validate_incoming(self, value: Mapping[str, Any], *, key: str) -> T:
        """Validate a value received from the stream (injects primary key)."""
        v2 = dict(value)
        v2[self.primary_key] = key
        return self._adapter.validate_python(v2)

    def _derive_key_from_value(self, value: Any) -> str | None:
        if isinstance(value, BaseModel):
            raw = getattr(value, self.primary_key, None)
        elif isinstance(value, Mapping):
            raw = value.get(self.primary_key)
        else:
            raw = None

        if raw is None:
            return None
        s = str(raw)
        return s if s != "" else None

    def insert(
        self,
        *,
        value: Any,
        key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ChangeEvent[T]:
        validated = self._validate(value, label="insert")
        final_key = key or self._derive_key_from_value(validated)
        if not final_key:
            raise ValueError(
                f"Cannot create {self.type} insert event: must provide either 'key' "
                f"or a value with a non-empty '{self.primary_key}' field"
            )
        merged: dict[str, Any] = dict(headers or {})
        merged["operation"] = "insert"
        return {
            "type": self.type,
            "key": final_key,
            "value": validated,
            "headers": merged,  # type: ignore[typeddict-item]
        }

    def update(
        self,
        *,
        value: Any,
        key: str | None = None,
        old_value: Any | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ChangeEvent[T]:
        validated = self._validate(value, label="update")
        validated_old: T | None = None
        if old_value is not None:
            validated_old = self._validate(old_value, label="update (old_value)")

        final_key = key or self._derive_key_from_value(validated)
        if not final_key:
            raise ValueError(
                f"Cannot create {self.type} update event: must provide either 'key' "
                f"or a value with a non-empty '{self.primary_key}' field"
            )

        merged: dict[str, Any] = dict(headers or {})
        merged["operation"] = "update"
        evt: ChangeEvent[T] = {
            "type": self.type,
            "key": final_key,
            "value": validated,
            "headers": merged,  # type: ignore[typeddict-item]
        }
        if validated_old is not None:
            evt["old_value"] = validated_old
        return evt

    def delete(
        self,
        *,
        key: str | None = None,
        old_value: Any | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ChangeEvent[T]:
        validated_old: T | None = None
        if old_value is not None:
            validated_old = self._validate(old_value, label="delete")

        final_key = key
        if final_key is None and validated_old is not None:
            final_key = self._derive_key_from_value(validated_old)

        if not final_key:
            raise ValueError(
                f"Cannot create {self.type} delete event: must provide either 'key' "
                f"or 'old_value' with a {self.primary_key} field"
            )

        merged: dict[str, Any] = dict(headers or {})
        merged["operation"] = "delete"
        evt: ChangeEvent[T] = {
            "type": self.type,
            "key": final_key,
            "headers": merged,  # type: ignore[typeddict-item]
        }
        if validated_old is not None:
            evt["old_value"] = validated_old
        return evt

    def upsert(
        self,
        *,
        value: Any,
        key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ChangeEvent[T]:
        validated = self._validate(value, label="upsert")
        final_key = key or self._derive_key_from_value(validated)
        if not final_key:
            raise ValueError(
                f"Cannot create {self.type} upsert event: must provide either 'key' "
                f"or a value with a non-empty '{self.primary_key}' field"
            )
        merged: dict[str, Any] = dict(headers or {})
        merged["operation"] = "upsert"
        return {
            "type": self.type,
            "key": final_key,
            "value": validated,
            "headers": merged,  # type: ignore[typeddict-item]
        }


StateSchema = dict[str, CollectionSchema[Any]]


def create_state_schema(defs: Mapping[str, CollectionDefinition[Any]]) -> StateSchema:
    for name in defs:
        if name in _RESERVED_COLLECTION_NAMES:
            raise ValueError(
                f"Reserved collection name {name!r} - this would collide with StreamDB "
                f"properties ({', '.join(sorted(_RESERVED_COLLECTION_NAMES))})"
            )

    # Validate no duplicate event types
    seen_types: dict[str, str] = {}
    for name, d in defs.items():
        if d.type in seen_types:
            raise ValueError(
                f"Duplicate event type {d.type!r} - used by both {seen_types[d.type]!r} "
                f"and {name!r} collections"
            )
        seen_types[d.type] = name

    return {name: CollectionSchema(definition=d) for name, d in defs.items()}
