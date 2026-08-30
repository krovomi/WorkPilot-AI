"""Aucun fichier texte du dépôt ne doit être ouvert sans déclarer son encodage.

Sans `encoding=`, Python retombe sur la locale du système. Sur Linux et macOS
c'est UTF-8 et rien ne se voit ; sur Windows c'est cp1252, et lire ou écrire un
JSON contenant un accent ou un emoji lève `UnicodeEncodeError`. Le dépôt annonce
Windows comme plateforme supportée, donc le défaut ne se manifestait que chez
l'utilisateur : 112 appels étaient dans ce cas, parmi lesquels les rapports de
migration, les votes d'équipe et l'écriture du token Windsurf.

`scripts/check_encoding.py` sait détecter exactement cela depuis toujours — il
est décrit dans `scripts/README.md` comme un hook de pré-commit — mais rien ne
l'exécutait : ni la CI, ni `.husky/`, ni un test. Ce test est ce qui lui manquait.
Il le réutilise plutôt que d'en reproduire la logique.

Ruff couvre aussi la règle (`PLW1514`), mais elle est en préversion : l'activer
imposerait `preview = true` dans `ruff.toml` et, avec lui, tout un lot de règles
instables sur un dépôt qui épingle ses versions d'outils.

`tests/` a d'abord été laissé de côté — ses fixtures ne partent pas chez
l'utilisateur — puis inclus, parce que la CI teste Windows et que ces fixtures y
écrivent de vrais fichiers : un test qui échoue sur cp1252 coûte le même
diagnostic qu'un bug, sans en être un.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_encoding import EncodingChecker  # noqa: E402

#: Tout le Python du dépôt : ce qui est livré, et les tests qui l'exercent.
SCANNED = ("apps/backend", "src", "utils", "scripts", "tests")

EXCLUDED_DIRS = {
    ".venv",
    "__pycache__",
    "node_modules",
    "grepai",  # dépendance embarquée, pas notre code
}


def _scanned_python_files() -> list[Path]:
    files: list[Path] = []
    for root in SCANNED:
        base = REPO_ROOT / root
        if not base.is_dir():
            continue
        for path in base.rglob("*.py"):
            if EXCLUDED_DIRS & set(path.parts):
                continue
            files.append(path)
    return files


def test_scan_covers_the_repository() -> None:
    """Un déplacement de répertoire doit casser ici plutôt que vider le test."""
    assert len(_scanned_python_files()) > 1000


def test_every_file_operation_declares_an_encoding() -> None:
    # Il n'y a plus de liste de faux positifs à tenir : les trois qui existaient
    # étaient du code Python cité dans une chaîne, et `check_encoding` ne
    # regarde plus que le code — commentaires et littéraux sont blanchis avant
    # le scan. La dette a disparu avec sa cause, pas avec une exception.
    checker = EncodingChecker()
    checker.check_files(_scanned_python_files())

    assert checker.issues == [], (
        "fichier texte ouvert sans encoding= — cp1252 sur Windows :\n"
        + "\n".join(checker.issues)
    )
