"""
Breaking Change Detector — Semantic diff between two API contracts.

Classifies each change as non-breaking, potentially breaking or breaking, the
same way for OpenAPI, GraphQL and protobuf, and marks the ones the new
contract declares intended (``x-breaking-acknowledged``, #389):

- **breaking**: endpoint, operation, type, field, parameter, enum value or
  response status removed; incompatible type change; a parameter, a request
  field or a GraphQL argument that becomes required; a protobuf field
  renumbered or an rpc's message changed;
- **potentially breaking**: deprecation; widening type change (``int32`` →
  ``int64``, ``integer`` → ``number``, ``Int`` → ``Float``); enum value added
  (exhaustive switches); required field added to a type whose direction is
  unknown; protobuf field renamed under the same number (wire-compatible,
  breaks JSON and generated code); a removed protobuf field whose number is
  reserved;
- **non-breaking**: additions (endpoint, optional field or parameter, type,
  response status).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum

from .contract_parser import ApiContract, ApiEndpoint, ApiField, ContractFormat

logger = logging.getLogger(__name__)


class ChangeCategory(str, Enum):
    NON_BREAKING = "non_breaking"
    POTENTIALLY_BREAKING = "potentially_breaking"
    BREAKING = "breaking"


class ChangeType(str, Enum):
    ENDPOINT_ADDED = "endpoint_added"
    ENDPOINT_REMOVED = "endpoint_removed"
    ENDPOINT_DEPRECATED = "endpoint_deprecated"
    FIELD_ADDED = "field_added"
    FIELD_REMOVED = "field_removed"
    FIELD_TYPE_CHANGED = "field_type_changed"
    FIELD_REQUIRED_ADDED = "field_required_added"
    FIELD_DEPRECATED = "field_deprecated"
    FIELD_RENAMED = "field_renamed"
    FIELD_NUMBER_CHANGED = "field_number_changed"
    TYPE_ADDED = "type_added"
    TYPE_REMOVED = "type_removed"
    PARAMETER_ADDED_REQUIRED = "parameter_added_required"
    PARAMETER_REMOVED = "parameter_removed"
    PARAMETER_BECAME_REQUIRED = "parameter_became_required"
    PARAMETER_TYPE_CHANGED = "parameter_type_changed"
    REQUEST_BODY_CHANGED = "request_body_changed"
    RESPONSE_STATUS_ADDED = "response_status_added"
    RESPONSE_STATUS_REMOVED = "response_status_removed"
    RESPONSE_TYPE_CHANGED = "response_type_changed"
    ENUM_VALUE_ADDED = "enum_value_added"
    ENUM_VALUE_REMOVED = "enum_value_removed"
    CONTRACT_REMOVED = "contract_removed"
    CONTRACT_ADDED = "contract_added"


@dataclass
class ContractChange:
    """A single detected change between two contract versions."""

    change_type: ChangeType
    category: ChangeCategory
    path: str
    description: str
    old_value: str = ""
    new_value: str = ""
    #: The new contract declares this change intended.
    acknowledged: bool = False


@dataclass
class ContractDiff:
    """Full diff result between two API contract versions."""

    changes: list[ContractChange] = field(default_factory=list)
    breaking_count: int = 0
    potentially_breaking_count: int = 0
    non_breaking_count: int = 0

    @property
    def has_breaking_changes(self) -> bool:
        return self.breaking_count > 0

    @property
    def unacknowledged_breaking(self) -> list[ContractChange]:
        return [
            c
            for c in self.changes
            if c.category == ChangeCategory.BREAKING and not c.acknowledged
        ]

    def count(self) -> None:
        self.breaking_count = sum(
            1 for c in self.changes if c.category == ChangeCategory.BREAKING
        )
        self.potentially_breaking_count = sum(
            1 for c in self.changes if c.category == ChangeCategory.POTENTIALLY_BREAKING
        )
        self.non_breaking_count = sum(
            1 for c in self.changes if c.category == ChangeCategory.NON_BREAKING
        )

    @property
    def summary(self) -> str:
        parts = []
        if self.breaking_count:
            parts.append(f"🔴 {self.breaking_count} breaking")
        if self.potentially_breaking_count:
            parts.append(f"🟡 {self.potentially_breaking_count} potentially breaking")
        if self.non_breaking_count:
            parts.append(f"🟢 {self.non_breaking_count} non-breaking")
        return ", ".join(parts) or "No changes detected"


#: Type changes an existing client still reads (old, new), compared
#: lower-case without the GraphQL ``!`` and list brackets.
_WIDENING = {
    ("integer", "number"),
    ("int32", "int64"),
    ("uint32", "uint64"),
    ("sint32", "sint64"),
    ("fixed32", "fixed64"),
    ("sfixed32", "sfixed64"),
    ("float", "double"),
    ("int", "float"),
    ("int", "long"),
}

_GRAPHQL_ROOTS = ("Query", "Mutation", "Subscription")

_B = ChangeCategory.BREAKING
_P = ChangeCategory.POTENTIALLY_BREAKING
_N = ChangeCategory.NON_BREAKING


def _norm(type_: str, fmt: str = "") -> str:
    core = type_.strip().lower().replace("!", "")
    return f"{core}:{fmt.lower()}" if fmt else core


def type_change_category(old: ApiField, new: ApiField) -> ChangeCategory | None:
    """None when the type is the same; else how much the change breaks."""
    if old.type == new.type and old.format == new.format:
        return None
    if old.type == new.type:  # only the format: int32 -> int64
        pair = (old.format.lower(), new.format.lower())
        return _P if pair in _WIDENING or not old.format else _B
    if old.type.replace("!", "") == new.type.replace("!", ""):
        return None  # nullability: reported as required, not as a type change
    pair = (_norm(old.type), _norm(new.type))
    return _P if pair in _WIDENING else _B


class BreakingChangeDetector:
    """Detect breaking changes between two API contract versions.

    Usage::

        detector = BreakingChangeDetector()
        diff = detector.diff(old_contract, new_contract)
        if diff.unacknowledged_breaking:
            alert_consumers(diff)
    """

    def diff(self, old: ApiContract, new: ApiContract) -> ContractDiff:
        """Compare two contracts and return a structured diff."""
        result = ContractDiff()
        self._new = new
        self._old = old
        self._result = result

        self._diff_endpoints(old, new)
        self._diff_types(old, new)
        self._diff_enums(old, new)

        for change in result.changes:
            change.acknowledged = new.is_acknowledged(change.path)
        result.count()
        return result

    def _add(
        self,
        change_type: ChangeType,
        category: ChangeCategory,
        path: str,
        description: str,
        old_value: str = "",
        new_value: str = "",
    ) -> None:
        self._result.changes.append(
            ContractChange(
                change_type, category, path, description, old_value, new_value
            )
        )

    # ── endpoints ────────────────────────────────────────────────────────

    def _diff_endpoints(self, old: ApiContract, new: ApiContract) -> None:
        # `/orders/{id}` and `/orders/{orderId}` are the same URL to a client.
        old_eps = {_shape(e.key): e for e in old.endpoints}
        new_eps = {_shape(e.key): e for e in new.endpoints}
        for shape, endpoint in old_eps.items():
            if shape not in new_eps:
                note = " (it was deprecated)" if endpoint.deprecated else ""
                self._add(
                    ChangeType.ENDPOINT_REMOVED,
                    _B,
                    endpoint.key,
                    f"Endpoint {endpoint.key} was removed{note}",
                )
        for shape, endpoint in new_eps.items():
            if shape not in old_eps:
                key = endpoint.key
                self._add(
                    ChangeType.ENDPOINT_ADDED, _N, key, f"Endpoint {key} was added"
                )
        for shape, endpoint in old_eps.items():
            if shape in new_eps:
                self._diff_endpoint_detail(endpoint, new_eps[shape], endpoint.key)

    def _diff_endpoint_detail(
        self, old_ep: ApiEndpoint, new_ep: ApiEndpoint, path: str
    ) -> None:
        if not old_ep.deprecated and new_ep.deprecated:
            self._add(
                ChangeType.ENDPOINT_DEPRECATED,
                _P,
                path,
                f"Endpoint {path} was deprecated",
            )
        self._diff_parameters(old_ep, new_ep, path)
        self._diff_request(old_ep, new_ep, path)
        self._diff_responses(old_ep, new_ep, path)

    def _diff_parameters(
        self, old_ep: ApiEndpoint, new_ep: ApiEndpoint, path: str
    ) -> None:
        # Path parameters are matched by position: renaming one changes no URL.
        old_path = [p for p in old_ep.parameters if p.description == "path"]
        new_path = [p for p in new_ep.parameters if p.description == "path"]
        for before, after in zip(old_path, new_path, strict=False):
            category = type_change_category(before, after)
            if category is not None:
                self._add(
                    ChangeType.PARAMETER_TYPE_CHANGED,
                    category,
                    f"{path}.params.{before.name}",
                    f"Path parameter '{before.name}' of {path} changed type",
                    _shown(before),
                    _shown(after),
                )
        old_params = {p.name: p for p in old_ep.parameters if p.description != "path"}
        new_params = {p.name: p for p in new_ep.parameters if p.description != "path"}
        rpc = old_ep.method == "RPC"
        for name, param in new_params.items():
            where = f"{path}.params.{name}"
            if name not in old_params:
                if param.required:
                    self._add(
                        ChangeType.PARAMETER_ADDED_REQUIRED,
                        _B,
                        where,
                        f"Required parameter '{name}' was added to {path}",
                    )
                continue
            before = old_params[name]
            if not before.required and param.required:
                self._add(
                    ChangeType.PARAMETER_BECAME_REQUIRED,
                    _B,
                    where,
                    f"Parameter '{name}' of {path} became required",
                )
            category = type_change_category(before, param)
            if category is not None:
                self._add(
                    ChangeType.PARAMETER_TYPE_CHANGED,
                    _B if rpc else category,
                    where,
                    (
                        f"The request message of {path} changed"
                        if rpc
                        else f"Parameter '{name}' of {path} changed type"
                    ),
                    _shown(before),
                    _shown(param),
                )
            self._diff_enum_values(
                before.enum, param.enum, where, f"parameter '{name}'"
            )
        for name in old_params:
            if name not in new_params:
                self._add(
                    ChangeType.PARAMETER_REMOVED,
                    _B,
                    f"{path}.params.{name}",
                    f"Parameter '{name}' was removed from {path}",
                )

    def _diff_request(
        self, old_ep: ApiEndpoint, new_ep: ApiEndpoint, path: str
    ) -> None:
        where = f"{path}.body"
        if not old_ep.body_required and new_ep.body_required:
            self._add(
                ChangeType.REQUEST_BODY_CHANGED,
                _B,
                where,
                f"The request body of {path} became required",
            )
        old_body = {f.name: f for f in old_ep.request_body}
        new_body = {f.name: f for f in new_ep.request_body}
        for name, item in new_body.items():
            before = old_body.get(name)
            if before is None:
                if item.required and old_body:
                    self._add(
                        ChangeType.FIELD_REQUIRED_ADDED,
                        _B,
                        f"{where}.{name}",
                        f"Required request field '{name}' was added to {path}",
                    )
                continue
            if not before.required and item.required:
                self._add(
                    ChangeType.FIELD_REQUIRED_ADDED,
                    _B,
                    f"{where}.{name}",
                    f"Request field '{name}' of {path} became required",
                )
            category = type_change_category(before, item)
            if category is not None:
                self._add(
                    ChangeType.REQUEST_BODY_CHANGED,
                    category,
                    f"{where}.{name}",
                    f"Request field '{name}' of {path} changed type",
                    _shown(before),
                    _shown(item),
                )

    def _diff_responses(
        self, old_ep: ApiEndpoint, new_ep: ApiEndpoint, path: str
    ) -> None:
        for status, fields in old_ep.responses.items():
            if status not in new_ep.responses:
                self._add(
                    ChangeType.RESPONSE_STATUS_REMOVED,
                    _B,
                    f"{path}.responses.{status}",
                    f"Response {status} of {path} was removed",
                )
                continue
            after = {f.name: f for f in new_ep.responses[status]}
            for item in fields:
                new_item = after.get(item.name)
                if new_item is None:
                    if item.name in ("schema", "result", "response"):
                        continue
                    self._add(
                        ChangeType.FIELD_REMOVED,
                        _B,
                        f"{path}.responses.{status}.{item.name}",
                        f"Field '{item.name}' was removed from response {status} of {path}",
                    )
                    continue
                category = type_change_category(item, new_item)
                if category is not None:
                    self._add(
                        ChangeType.RESPONSE_TYPE_CHANGED,
                        _B if old_ep.method == "RPC" else category,
                        f"{path}.responses.{status}.{item.name}",
                        f"Response {status} of {path} changed type",
                        _shown(item),
                        _shown(new_item),
                    )
        for status in new_ep.responses:
            if status not in old_ep.responses:
                self._add(
                    ChangeType.RESPONSE_STATUS_ADDED,
                    _N,
                    f"{path}.responses.{status}",
                    f"Response {status} was added to {path}",
                )

    # ── types ────────────────────────────────────────────────────────────

    def _diff_types(self, old: ApiContract, new: ApiContract) -> None:
        roots = _GRAPHQL_ROOTS if new.format == ContractFormat.GRAPHQL else ()
        for type_name, fields in old.types.items():
            if type_name in roots:
                continue  # its fields are the endpoints, compared above
            if type_name not in new.types:
                self._add(
                    ChangeType.TYPE_REMOVED,
                    _B,
                    type_name,
                    f"Type '{type_name}' was removed",
                )
            else:
                self._diff_fields(fields, new.types[type_name], type_name)
        for type_name in new.types:
            if type_name not in old.types and type_name not in roots:
                self._add(
                    ChangeType.TYPE_ADDED,
                    _N,
                    type_name,
                    f"Type '{type_name}' was added",
                )

    def _diff_fields(
        self, old_fields: list[ApiField], new_fields: list[ApiField], parent: str
    ) -> None:
        old_map = {f.name: f for f in old_fields}
        new_map = {f.name: f for f in new_fields}
        proto = self._new.format == ContractFormat.PROTOBUF
        by_number = {f.number: f for f in new_fields if f.number is not None}
        reserved = self._new.reserved.get(parent, set())

        for name, before in old_map.items():
            path = f"{parent}.{name}"
            after = new_map.get(name)
            if after is None:
                renamed = by_number.get(before.number) if proto else None
                if renamed is not None and renamed.name not in old_map:
                    self._add(
                        ChangeType.FIELD_RENAMED,
                        _P,
                        path,
                        f"Field '{name}' of {parent} was renamed '{renamed.name}' "
                        f"(same number {before.number}: the wire format is unchanged, "
                        "JSON and generated code are not)",
                        name,
                        renamed.name,
                    )
                    self._diff_field(before, renamed, parent, path)
                    continue
                kept = proto and (str(before.number) in reserved or name in reserved)
                self._add(
                    ChangeType.FIELD_REMOVED,
                    _P if kept else _B,
                    path,
                    f"Field '{name}' was removed from {parent}"
                    + (" (its number is reserved)" if kept else ""),
                )
                continue
            if proto and before.number != after.number:
                self._add(
                    ChangeType.FIELD_NUMBER_CHANGED,
                    _B,
                    path,
                    f"Field '{name}' of {parent} changed number",
                    str(before.number),
                    str(after.number),
                )
            self._diff_field(before, after, parent, path)

        for name, item in new_map.items():
            if name in old_map or (proto and _renamed_from(item, old_fields, new_map)):
                continue
            if item.required:
                breaks = parent in self._new.input_types or proto
                self._add(
                    ChangeType.FIELD_REQUIRED_ADDED,
                    _B if breaks else _P,
                    f"{parent}.{name}",
                    f"Required field '{name}' was added to {parent}",
                )
            else:
                self._add(
                    ChangeType.FIELD_ADDED,
                    _N,
                    f"{parent}.{name}",
                    f"Field '{name}' was added to {parent}",
                )

    def _diff_field(
        self, before: ApiField, after: ApiField, parent: str, path: str
    ) -> None:
        category = type_change_category(before, after)
        if category is not None:
            self._add(
                ChangeType.FIELD_TYPE_CHANGED,
                category,
                path,
                f"Field '{after.name}' of {parent} changed type from "
                f"'{_shown(before)}' to '{_shown(after)}'",
                _shown(before),
                _shown(after),
            )
        if not before.required and after.required:
            self._add(
                ChangeType.FIELD_REQUIRED_ADDED,
                _B
                if parent in self._new.input_types
                or self._new.format != ContractFormat.GRAPHQL
                else _P,
                path,
                f"Field '{after.name}' in {parent} became required",
            )
        if not before.deprecated and after.deprecated:
            self._add(
                ChangeType.FIELD_DEPRECATED,
                _P,
                path,
                f"Field '{after.name}' of {parent} was deprecated",
            )
        self._diff_enum_values(before.enum, after.enum, path, f"field '{after.name}'")
        self._diff_arguments(before, after, path)

    def _diff_arguments(self, before: ApiField, after: ApiField, path: str) -> None:
        """GraphQL field arguments: a new required one, or a removed one, breaks callers."""
        old_args = {a.name: a for a in before.children}
        new_args = {a.name: a for a in after.children}
        for name, arg in new_args.items():
            prior = old_args.get(name)
            if (prior is None and arg.required) or (
                prior and not prior.required and arg.required
            ):
                self._add(
                    ChangeType.PARAMETER_ADDED_REQUIRED,
                    _B,
                    f"{path}.args.{name}",
                    f"Argument '{name}' of {path} is now required",
                )
            elif prior is not None:
                category = type_change_category(prior, arg)
                if category is not None:
                    self._add(
                        ChangeType.PARAMETER_TYPE_CHANGED,
                        category,
                        f"{path}.args.{name}",
                        f"Argument '{name}' of {path} changed type",
                        prior.type,
                        arg.type,
                    )
        for name in old_args:
            if name not in new_args:
                self._add(
                    ChangeType.PARAMETER_REMOVED,
                    _B,
                    f"{path}.args.{name}",
                    f"Argument '{name}' was removed from {path}",
                )

    # ── enums ────────────────────────────────────────────────────────────

    def _diff_enums(self, old: ApiContract, new: ApiContract) -> None:
        for name, values in old.enums.items():
            if name not in new.enums:
                if name not in new.types:
                    self._add(
                        ChangeType.TYPE_REMOVED, _B, name, f"Enum '{name}' was removed"
                    )
                continue
            self._diff_enum_values(values, new.enums[name], name, f"enum '{name}'")
        for name in new.enums:
            if name not in old.enums and name not in old.types:
                self._add(ChangeType.TYPE_ADDED, _N, name, f"Enum '{name}' was added")

    def _diff_enum_values(
        self, before: list[str], after: list[str], path: str, what: str
    ) -> None:
        if not before and not after:
            return
        old_names = {v.split("=", 1)[0]: v for v in before}
        new_names = {v.split("=", 1)[0]: v for v in after}
        for name, value in old_names.items():
            if name not in new_names:
                self._add(
                    ChangeType.ENUM_VALUE_REMOVED,
                    _B,
                    f"{path}.{name}",
                    f"Value '{name}' was removed from {what}",
                )
            elif new_names[name] != value:
                self._add(
                    ChangeType.ENUM_VALUE_REMOVED,
                    _B,
                    f"{path}.{name}",
                    f"Value '{name}' of {what} changed number",
                    value,
                    new_names[name],
                )
        if before:  # a new enum constraint is not a value added
            for name in new_names:
                if name not in old_names:
                    self._add(
                        ChangeType.ENUM_VALUE_ADDED,
                        _P,
                        f"{path}.{name}",
                        f"Value '{name}' was added to {what} (a client that switches "
                        "over every value must handle it)",
                    )


def _shape(key: str) -> str:
    return re.sub(r"\{[^}]*\}", "{}", key)


def _shown(item: ApiField) -> str:
    return f"{item.type} ({item.format})" if item.format else item.type


def _renamed_from(item: ApiField, old_fields: list[ApiField], new_map: dict) -> bool:
    """A new protobuf field that took the number of a removed one (reported as a rename)."""
    return any(
        f.number is not None and f.number == item.number and f.name not in new_map
        for f in old_fields
    )
