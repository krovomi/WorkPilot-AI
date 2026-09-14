"""The four questions a user gets to answer about watermark stripping.

Same shape as `rtk.settings` and `libdocs.preflight`: every switch is read from
the environment **and** from `.workpilot/.env`, because that file is what the
Electron settings screen writes and a toggle that only reaches the CLI is a
toggle half the product cannot see. Real environment variables win over the
file — a CLI user who exported something should not be overridden by a stale
line on disk.

Two of the defaults differ from upstream's, and both differences are about the
same thing: this cleaner runs over **source files somebody will compile**, not
over prose somebody will publish.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "ENABLED_ENV",
    "MAX_BYTES_ENV",
    "NORMALIZE_SPACES_ENV",
    "SETTINGS_KEYS",
    "STRIP_BIDI_ENV",
    "apply_project_env",
    "is_enabled",
    "max_bytes",
    "normalize_spaces",
    "project_env",
    "strip_bidi",
]

#: Master switch. On by default: the cost on a file with nothing to strip is
#: one `str.isascii()` call, and a feature that is off by default produces
#: clean files only for the users who already knew they needed it.
ENABLED_ENV = "WATERMARKS_ENABLED"

#: Whether U+00A0 and its fifteen siblings are rewritten to a plain space.
#: **Off** here, where upstream has it on. Upstream cleans prose; this cleans
#: what an agent commits, and a no-break space is load-bearing in the two
#: languages this product ships: French typography puts one before `?`, `!`,
#: `:` and `;`, and the repository's own `fr/*.json` locale files are full of
#: them. Rewriting those is not removing a watermark, it is losing a decision
#: a translator made.
NORMALIZE_SPACES_ENV = "WATERMARKS_NORMALIZE_SPACES"

#: Whether *well-formed* bidirectional embeddings are stripped too. Off by
#: default, because a correctly paired RLE/PDF run is how Arabic and Hebrew
#: text is written, and an `ar/*.json` is a file an agent may legitimately
#: produce. Turning it on is the Trojan Source hardening (CVE-2021-42574),
#: where the attack is precisely a *well-formed* embedding that makes a
#: reviewer read one thing and the compiler read another — so it is worth
#: having, and it is worth being a decision rather than a default.
#: Unpaired and out-of-context bidi controls are stripped either way.
STRIP_BIDI_ENV = "WATERMARKS_STRIP_BIDI"

#: Above this, the content is passed through untouched and the skip is recorded.
#: The decision table is a Python loop over every character; a megabyte of
#: generated fixture data is not worth a second of wall clock, and a file that
#: size is not prose carrying an invisible mark.
MAX_BYTES_ENV = "WATERMARKS_MAX_BYTES"

DEFAULT_MAX_BYTES = 1024 * 1024

SETTINGS_KEYS = (
    ENABLED_ENV,
    NORMALIZE_SPACES_ENV,
    STRIP_BIDI_ENV,
    MAX_BYTES_ENV,
)

_WORKPILOT_DIR = ".workpilot"


def _truthy(value: object, default: bool) -> bool:
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def is_enabled(env: dict | None = None) -> bool:
    """Whether generated content is cleaned at all in this process."""
    source = os.environ if env is None else env
    return _truthy(source.get(ENABLED_ENV, "true"), True)


def normalize_spaces(env: dict | None = None) -> bool:
    source = os.environ if env is None else env
    return _truthy(source.get(NORMALIZE_SPACES_ENV, "false"), False)


def strip_bidi(env: dict | None = None) -> bool:
    source = os.environ if env is None else env
    return _truthy(source.get(STRIP_BIDI_ENV, "false"), False)


def max_bytes(env: dict | None = None) -> int:
    source = os.environ if env is None else env
    raw = source.get(MAX_BYTES_ENV)
    if raw is None:
        return DEFAULT_MAX_BYTES
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_MAX_BYTES
    # A zero or negative cap would disable cleaning through a knob that is
    # documented as a size, which is a confusing way to turn a feature off.
    # `WATERMARKS_ENABLED=0` is the way to turn it off.
    return value if value > 0 else DEFAULT_MAX_BYTES


def project_env(project_dir: Path | str) -> dict[str, str]:
    """The watermark settings a project carries in `.workpilot/.env`."""
    path = Path(project_dir) / _WORKPILOT_DIR / ".env"
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip()
        if key in SETTINGS_KEYS:
            values[key] = raw.strip().strip("\"'")
    return values


def apply_project_env(project_dir: Path | str) -> dict[str, str]:
    """Fold a project's `.workpilot/.env` watermark keys into `os.environ`.

    Only keys the environment does not already carry: an exported value is a
    decision made later than a file, and the file is the default it overrides.
    Returns what was applied, so a caller can say so.
    """
    applied: dict[str, str] = {}
    for key, value in project_env(project_dir).items():
        if key not in os.environ:
            os.environ[key] = value
            applied[key] = value
    return applied
