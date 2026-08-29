"""Le code livré ne doit jamais ouvrir un fichier texte sans déclarer son encodage.

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
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_encoding import EncodingChecker  # noqa: E402

#: Le code qui part chez l'utilisateur. `tests/` en est absent volontairement :
#: ses fixtures écrivent dans des répertoires temporaires, elles ne sont pas
#: livrées, et les y inclure ajouterait ~700 corrections à un sujet qui n'est
#: pas le leur. À traiter séparément.
SHIPPED = ("apps/backend", "src", "utils", "scripts")

EXCLUDED_DIRS = {
    ".venv",
    "__pycache__",
    "node_modules",
    "grepai",  # dépendance embarquée, pas notre code
}

#: Faux positifs : du code Python à l'intérieur d'une chaîne de caractères.
#: `check_encoding` lit le fichier ligne à ligne et ne distingue pas une chaîne
#: d'une instruction. Ces trois-là sont des extraits montrés à l'utilisateur ou
#: exécutés dans le bac à sable — les corriger changerait le texte, pas un appel.
KNOWN_FALSE_POSITIVES = {
    ("apps/backend/code_playground/test_runner.py", 145),
    ("apps/backend/code_playground/test_runner.py", 157),
    ("apps/backend/performance/optimizer.py", 190),
}


def _shipped_python_files() -> list[Path]:
    files: list[Path] = []
    for root in SHIPPED:
        base = REPO_ROOT / root
        if not base.is_dir():
            continue
        for path in base.rglob("*.py"):
            if EXCLUDED_DIRS & set(path.parts):
                continue
            files.append(path)
    return files


def _parse(issue: str) -> tuple[str, int] | None:
    """« chemin:ligne - message » -> (chemin relatif au dépôt, ligne)."""
    location = issue.split(" - ", 1)[0]
    path, _, lineno = location.rpartition(":")
    if not lineno.isdigit():
        return None
    # Le checker rapporte le chemin tel qu'il l'a reçu, ici absolu.
    try:
        path = str(Path(path).resolve().relative_to(REPO_ROOT))
    except ValueError:
        pass
    return path.replace("\\", "/"), int(lineno)


def test_scan_covers_the_shipped_code() -> None:
    """Un déplacement de répertoire doit casser ici plutôt que vider le test."""
    assert len(_shipped_python_files()) > 500


def test_shipped_code_declares_an_encoding() -> None:
    checker = EncodingChecker()
    checker.check_files(_shipped_python_files())

    offenders = []
    for issue in checker.issues:
        parsed = _parse(issue)
        if parsed and parsed in KNOWN_FALSE_POSITIVES:
            continue
        offenders.append(issue)

    assert offenders == [], (
        "fichier texte ouvert sans encoding= — cp1252 sur Windows :\n"
        + "\n".join(offenders)
    )
