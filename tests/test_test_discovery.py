"""Aucun fichier de test ne doit vivre hors des chemins que pytest collecte.

`pytest.ini` bornait `testpaths` à `tests/`, et la CI passait `../../tests/` en
dur. **120 fichiers `test_*.py` vivaient ailleurs** — 1 603 tests qui ne
tournaient nulle part, ni en local ni en CI. Ils avaient dérivé en silence : des
mocks pointant vers des méthodes renommées, des assertions figées sur des
libellés traduits depuis, et trois bugs de production que personne ne voyait
parce que le test qui les aurait montrés n'était jamais exécuté.

Rien ne pouvait le signaler : un test qui ne tourne pas ne se plaint pas. Ce
fichier est ce qui manquait.

Il liste les fichiers de test du dépôt et vérifie qu'ils tombent tous sous un
`testpaths`. Un nouveau fichier posé hors périmètre échoue ici, au lieu de
rejoindre silencieusement les 120.
"""

from __future__ import annotations

import configparser
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"

#: Répertoires sans code de test à nous.
EXCLUDED = {
    ".venv",
    "__pycache__",
    "node_modules",
    ".git",
    "grepai",  # dépendance embarquée
}


def _testpaths() -> list[Path]:
    """Les chemins que la CI collecte, lus dans la configuration qu'elle utilise.

    La CI lance pytest depuis `apps/backend`, donc c'est ce `pytest.ini` qui la
    configure — pas celui de la racine. Les lire plutôt que les recopier évite
    qu'un élargissement de l'un laisse ce test derrière.
    """
    parser = configparser.ConfigParser()
    parser.read(BACKEND / "pytest.ini", encoding="utf-8")
    raw = parser.get("pytest", "testpaths")
    return [(BACKEND / entry).resolve() for entry in raw.split() if entry.strip()]


def _test_files() -> list[Path]:
    files: list[Path] = []
    for path in REPO_ROOT.rglob("test_*.py"):
        if EXCLUDED & set(path.parts):
            continue
        files.append(path.resolve())
    return files


def test_the_scan_finds_the_suite() -> None:
    """Un déplacement de répertoire doit casser ici plutôt que vider le test."""
    assert len(_test_files()) > 200


def test_every_test_file_is_collected() -> None:
    roots = _testpaths()
    stranded = [
        str(path.relative_to(REPO_ROOT))
        for path in _test_files()
        if not any(path == root or path.is_relative_to(root) for root in roots)
    ]

    assert stranded == [], (
        "fichiers de test hors des `testpaths` d'apps/backend/pytest.ini — "
        "ils ne tourneront nulle part :\n" + "\n".join(sorted(stranded))
    )


def test_package_qualified_backend_import_survives_collection_mock_pollution() -> None:
    """Un faux ``apps.backend`` laissé par un test ne doit pas casser le suivant."""
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((str(BACKEND), str(REPO_ROOT)))
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "--collect-only",
            "-q",
            "core/test_conversation_log.py",
            "../../tests/backend/test_ssrf_protection.py",
        ],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
