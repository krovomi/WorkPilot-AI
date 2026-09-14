"""Where the vendored cleaner is, whether it loads, and whether it is intact.

The module is loaded by path rather than imported as a package member, and that
is deliberate: `vendor/watermarks/` holds upstream's file byte-for-byte, with no
`__init__.py` of ours beside it. A vendored tree that carries a file we wrote is
a tree where "did this change?" stops having a clean answer — the receipt would
be attesting to a mix of upstream's bytes and ours.

Nothing here raises. A checkout whose `vendor/` was deleted, or a Python that
refuses the module, degrades to "no cleaning" and says so in the doctor; the
alternative is a build that fails because a cosmetic pass could not run.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType

from core.vendor_manifest import RECEIPT_NAME, tree_digest

logger = logging.getLogger(__name__)

__all__ = [
    "Condition",
    "Readiness",
    "check",
    "engine",
    "pin",
    "reset_cache",
    "vendored_root",
]

# `apps/backend/vendor/watermarks` — two parents up from this file
# (`watermarks/` -> `apps/backend/`).
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_VENDORED = _BACKEND_ROOT / "vendor" / "watermarks"

_MODULE_NAME = "workpilot_vendor_watermarks_text_unicode"


class _Unloaded:
    """The "not attempted yet" state, which ``None`` cannot express.

    ``None`` is a real answer here — the vendored tree was looked for and could
    not be loaded — and caching *that* is the point: a checkout without
    `vendor/` would otherwise pay an `is_file()` and a traceback on every tool
    call an agent makes. Holding the two states as a value plus a boolean
    beside it was two pieces of state that had to agree, and keeping them in
    step was work nobody was doing on purpose. One sentinel says both.
    """

    __slots__ = ()


_UNLOADED = _Unloaded()
_lock = threading.Lock()
_engine: ModuleType | _Unloaded | None = _UNLOADED


def vendored_root() -> Path:
    """The directory the vendoring script writes. Always this one."""
    return _VENDORED


def engine() -> ModuleType | None:
    """The vendored Layer A module, or None if it cannot be loaded.

    Cached for the life of the process, including the failure: a checkout with
    no `vendor/` would otherwise pay an `is_file()` and a traceback on every
    single tool call an agent makes.
    """
    global _engine
    if isinstance(_engine, _Unloaded):
        with _lock:
            # Checked again under the lock: two threads reaching the first test
            # together must still load once.
            if isinstance(_engine, _Unloaded):
                _engine = _load()
    cached = _engine
    return None if isinstance(cached, _Unloaded) else cached


def _load() -> ModuleType | None:
    source = _VENDORED / "text_unicode.py"
    if not source.is_file():
        logger.debug("watermarks: vendored cleaner missing at %s", source)
        return None
    try:
        spec = importlib.util.spec_from_file_location(_MODULE_NAME, source)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        # Registered *before* it executes, and that is not optional. The module
        # decorates two `@dataclass`es, and `dataclasses` resolves annotations
        # through `sys.modules[cls.__module__].__dict__`; with the name absent
        # that lookup returns None and the import dies on an `AttributeError`
        # from inside the standard library, which reads like anything but the
        # missing registration it is.
        sys.modules[_MODULE_NAME] = module
        executed = False
        try:
            spec.loader.exec_module(module)
            executed = True
        finally:
            # Registering before execution is required, as above; leaving a
            # half-executed module behind under that name is not. `finally`
            # rather than `except BaseException`: the cleanup has to run for a
            # KeyboardInterrupt too, and naming that base class in order to
            # re-raise it is a wider catch than the job needs.
            if not executed:
                sys.modules.pop(_MODULE_NAME, None)
    except Exception:  # noqa: BLE001 - a cosmetic pass never fails a build
        logger.debug("watermarks: vendored cleaner failed to load", exc_info=True)
        return None
    # Loaded is not the same as usable. A future upstream that renames these is
    # a tree this integration cannot drive, and finding that out here is better
    # than finding it out inside a hook on somebody's build.
    if not all(hasattr(module, name) for name in ("clean_text", "inspect_text")):
        logger.debug("watermarks: vendored cleaner lacks clean_text/inspect_text")
        return None
    return module


def reset_cache() -> None:
    """Forget the loaded module. For tests that move the vendored tree."""
    global _engine
    with _lock:
        _engine = _UNLOADED


def pin() -> dict[str, str]:
    """What the receipt says this tree is — source, ref, commit, licence."""
    try:
        receipt = json.loads((_VENDORED / RECEIPT_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        key: str(receipt.get(key, ""))
        for key in ("source", "ref", "commit", "license")
        if receipt.get(key)
    }


@dataclass(frozen=True)
class Condition:
    """One thing that must hold, and the sentence that fixes it when it does not."""

    name: str
    ok: bool
    detail: str = ""
    remedy: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "remedy": self.remedy,
        }


@dataclass(frozen=True)
class Readiness:
    ok: bool
    pin: dict[str, str] = field(default_factory=dict)
    conditions: tuple[Condition, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "pin": dict(self.pin),
            "conditions": [c.to_dict() for c in self.conditions],
        }


def check() -> Readiness:
    """Can the cleaner run here, and is the tree the one the receipt names?

    Integrity is **reported, never enforced**. A mismatch means somebody edited
    a vendored file — a formatter, an autofix bot, or a person debugging — and
    refusing to clean anything because of it would turn a cosmetic anomaly into
    a behaviour change nobody asked for. CI is where the mismatch is a failure:
    `tests/test_watermarks_vendor.py` compares the same two numbers and fails.
    """
    conditions: list[Condition] = []

    loaded = engine() is not None
    conditions.append(
        Condition(
            name="engine",
            ok=loaded,
            detail=(
                "vendored Layer A cleaner loaded"
                if loaded
                else f"cannot load {_VENDORED / 'text_unicode.py'}"
            ),
            remedy="" if loaded else "python3 scripts/vendor_watermarks.py",
        )
    )

    recorded = ""
    try:
        recorded = str(
            json.loads((_VENDORED / RECEIPT_NAME).read_text(encoding="utf-8")).get(
                "tree_sha256", ""
            )
        )
    except (OSError, json.JSONDecodeError):
        recorded = ""
    actual = tree_digest(_VENDORED) if _VENDORED.is_dir() else ""
    intact = bool(recorded) and recorded == actual
    conditions.append(
        Condition(
            name="integrity",
            ok=intact,
            detail=(
                "tree matches its receipt"
                if intact
                else "vendored tree differs from VENDOR.json"
            ),
            remedy="" if intact else "python3 scripts/vendor_watermarks.py --check",
        )
    )

    return Readiness(ok=loaded, pin=pin(), conditions=tuple(conditions))
