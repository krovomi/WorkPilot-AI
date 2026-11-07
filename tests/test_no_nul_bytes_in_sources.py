"""Aucun fichier source suivi par git ne doit contenir d'octet NUL.

git range parmi les binaires un fichier qui a un NUL dans ses 8 000 premiers
octets : une PR qui le touche n'affiche plus que « Binary files differ », et
`grep` le saute. Deux fichiers TypeScript en avaient un, écrit tel quel comme
séparateur dans une template string (`main/task-log-service.ts`,
`shared/utils/task-logs-by-model.ts`) ; l'échappement `\\u0000` donne la même
chaîne à l'exécution et garde le fichier lisible.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SOURCE_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".cjs",
    ".mjs",
    ".json",
    ".md",
    ".yml",
    ".yaml",
}


def _tracked_sources() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
    ).stdout
    names = [n.decode("utf-8") for n in out.split(b"\0") if n]
    return [
        REPO_ROOT / n
        for n in names
        if Path(n).suffix in SOURCE_SUFFIXES and (REPO_ROOT / n).is_file()
    ]


def test_no_tracked_source_file_holds_a_nul_byte() -> None:
    files = _tracked_sources()
    assert files, "git ls-files returned no source file"
    offenders = [
        str(path.relative_to(REPO_ROOT)) for path in files if b"\0" in path.read_bytes()
    ]
    assert offenders == [], (
        "NUL byte in source files (write it as an escape, e.g. \\u0000): "
        + ", ".join(offenders)
    )
