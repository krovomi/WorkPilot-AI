"""watermarks — the invisible characters a model leaves behind, removed on write.

Upstream: https://github.com/guillaumemeyer/watermarks-remover (MIT). Layer A of
that project is a decision table over Unicode: which invisible codepoint is a
watermark carrier, and which one is load-bearing — a ZWJ inside an emoji
sequence, a joiner between two Arabic letters, a filler after a Hangul jamo.
That table is vendored at `vendor/watermarks/` and is never reimplemented here.

Why a code product cares. Zero-width characters, exotic spaces, bidi controls
and tag characters are how provenance marks ride in model output, and they
survive copy-paste into a repository. In prose they are invisible; in a source
file they are a `SyntaxError` a reviewer cannot see, an identifier that does not
match itself, a diff full of changes nobody made, and a grep that finds nothing.
The cheapest moment to remove them is before the bytes reach the disk.

| Module     | Answers                                                           |
|------------|-------------------------------------------------------------------|
| `runtime`  | is the vendored table loadable, and is the tree the receipt's one  |
| `settings` | has the user turned it on, and how aggressive may it be            |
| `clean`    | given text on its way to disk, the clean text — and what changed   |
| `hook`     | the PreToolUse hook every agent Write and Edit passes through      |
| `ledger`   | `<spec_dir>/watermarks.jsonl` — the record of every silent edit    |
| `api`      | `GET /api/watermarks/status`                                       |

Everything fails open. A checkout with no `vendor/` tree, a settings key turned
off, content above the size cap, upstream raising: the content is written
exactly as the model produced it, and the reason is reported rather than
hidden. The worst this integration can do to a build is nothing.
"""

from __future__ import annotations

from .clean import Cleaning, clean_generated
from .hook import CLEANED_TOOLS, make_watermarks_hook
from .ledger import LEDGER_NAME, read_entries, record
from .runtime import Condition, Readiness, check, engine, pin, reset_cache
from .settings import (
    apply_project_env,
    is_enabled,
    max_bytes,
    normalize_spaces,
    project_env,
    strip_bidi,
)

__all__ = [
    "CLEANED_TOOLS",
    "LEDGER_NAME",
    "Cleaning",
    "Condition",
    "Readiness",
    "apply_project_env",
    "check",
    "clean_generated",
    "engine",
    "is_enabled",
    "make_watermarks_hook",
    "max_bytes",
    "normalize_spaces",
    "pin",
    "project_env",
    "read_entries",
    "record",
    "reset_cache",
    "strip_bidi",
]
