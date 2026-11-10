"""The provenance dossier of a task's pull request (prospective P5).

Who wrote the code, with which model, from which dependencies, and what was
checked before it was proposed: see `dossier.py`.
"""

from .dossier import (
    DOSSIER_DIR,
    DOSSIER_FILE,
    SBOM_FILE,
    build_dossier,
    dossier_markdown,
    pr_block,
    purl,
    write_dossier,
)

__all__ = [
    "DOSSIER_DIR",
    "DOSSIER_FILE",
    "SBOM_FILE",
    "build_dossier",
    "dossier_markdown",
    "pr_block",
    "purl",
    "write_dossier",
]
