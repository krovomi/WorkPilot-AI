"""The server image leaves the backend directory to the server user.

The backend writes beside its code at startup (`websocket_server.log`). A
`COPY` into `/app/apps/backend` before the `--chown` one creates that
directory as root, and the server dies on a PermissionError: the CI
`server-image` job caught it on the first real build.
"""

from __future__ import annotations

from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "deploy" / "Dockerfile.server"


def test_only_the_chowned_copy_creates_the_backend_directory():
    copies = [
        line.split()
        for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
        if line.startswith("COPY ")
    ]
    into_backend = [c for c in copies if c[-1].startswith("/app/apps/backend")]
    assert into_backend, "the backend is not copied into the image"
    assert all("--chown=workpilot:workpilot" in c for c in into_backend), into_backend


def test_the_server_does_not_run_as_root():
    lines = DOCKERFILE.read_text(encoding="utf-8").splitlines()
    users = [line.split()[1] for line in lines if line.startswith("USER ")]
    assert users and users[-1] == "workpilot"
