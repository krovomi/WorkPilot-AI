"""What a vendored tree claims to be, and whether it still is.

`apps/backend/vendor/` now holds two upstreams — the archify renderer and the
Layer A cleaner of watermarks-remover — and each carries a `VENDOR.json` written
by its own `scripts/vendor_*.py` and read back by its own doctor and contract
test. The *manifest format* is one thing across both, so it is defined once.

This used to live in `architecture_visualizer/archify/runtime.py`, correctly:
while there was one vendored tree, the question "is this tree the one it claims
to be" had one asker. The second tree is what moved it here, because the
alternative was copying `file_digests` — and with it the Windows ordering bug
its docstring records — into a second module that would have re-derived the bug
before it re-derived the fix.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

__all__ = ["RECEIPT_NAME", "file_digests", "tree_digest"]

#: The receipt names itself, so it cannot be part of what it attests to.
RECEIPT_NAME = "VENDOR.json"


def _is_host_artifact(path: Path, root: Path) -> bool:
    """Whether this file is something the host made, not something upstream shipped.

    A vendored Python module gets a `__pycache__` beside it the first time
    anything imports it, and that directory is a property of the machine — its
    interpreter version, its mtimes — not of the pin. Folding it into the
    digest made the receipt disagree with itself between one run and the next,
    which is a check that cries wolf and therefore a check nobody keeps.
    """
    relative = path.relative_to(root)
    return "__pycache__" in relative.parts or relative.suffix in (".pyc", ".pyo")


def file_digests(root: Path) -> dict[str, str]:
    """Every vendored file, by repository-relative path, with its sha256.

    Ordered by the **posix path string**, never by sorting `Path` objects.
    `PurePath` comparison goes through `_str_normcase`, which is lowercased on
    Windows, so `sorted(root.rglob("*"))` yields one order on Linux and another
    on Windows — and a digest folded over that order then disagrees with itself
    across platforms while every file is byte-identical. That is exactly how
    this failed: the Linux receipt said `570ef3c6…` and the Windows runner
    computed `827c274b…` from the same bytes.
    """
    digests = {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file() and p.name != RECEIPT_NAME and not _is_host_artifact(p, root)
    }
    return {relative: digests[relative] for relative in sorted(digests)}


def tree_digest(root: Path) -> str:
    """One hash over every vendored file's path and contents.

    Defined here rather than in the vendoring scripts because two places
    computing a digest is two answers to "is this tree the one it claims to
    be". The script writes it; the doctor and the contract test read it.

    Path and content both go in, so a renamed file with identical bytes still
    changes the digest. The receipt itself is excluded — it carries the result.
    """
    summary = hashlib.sha256()
    for relative, digest in file_digests(root).items():
        summary.update(f"{digest}  {relative}\n".encode())
    return summary.hexdigest()
