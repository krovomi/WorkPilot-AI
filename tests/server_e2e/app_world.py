"""A server for the desktop app's end-to-end spec, seeded with two teams.

``apps/frontend/e2e/server-mode.server-e2e.ts`` starts this script and writes
one JSON line to its standard input: the passwords it drew for the people
below (``{"alice": ..., "bob": ..., "carol": ...}``). The script seeds the
server with them, writes one JSON line to its standard output (the server's
URL, the project, each person's email, never a password), and serves until
the spec closes its standard input; it then stops the server and removes
everything it made.

The server is ``stack.py``'s (migrations, streaming server, API under uvicorn,
a fake agent in place of the model) on a SQLite database in a temporary
directory, unless ``WORKPILOT_E2E_DATABASE_URL`` names another one. Two
organizations: in the first, Alice (its administrator, who registers the
projects) and Bob (a member of each); in the second, Carol. "Team Board" is
cloned from a local repository; "Team Site" from GitHub and "Team Docs" from
GitLab, both served by the fake forges of ``fake_forge.py``, whose address
(``forgeUrl``) gives the spec what they were asked. "Team App" is cloned from
the local repository too, its board filled before anyone signs in
(``world_cards.py``: a card whose captures wait for review, cards to ask about). Their
passwords stay with the spec that drew them; the platform administrator's is
drawn here, and neither is ever written out.

Usage, from the repository root: ``python -m tests.server_e2e.app_world``.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import Fernet

from tests.server_e2e import stack as e2e
from tests.server_e2e.fake_backend.fake_agent import RELEASE_FILE, REPORT_FILE
from tests.server_e2e.fake_forge import GITHUB_CLONE_URL, GITLAB_CLONE_URL, FakeForge
from tests.server_e2e.world_cards import seed_app_cards

PROJECT_NAME = "Team Board"
#: The same team's projects on GitHub and on GitLab, served by the fake forges
#: (``fake_forge.py``): their issues, pull and merge requests go through the
#: server's relay with each person's own token.
GITHUB_PROJECT = "Team Site"
GITLAB_PROJECT = "Team Docs"
#: A project whose board the world fills before the apps sign in
#: (``world_cards.py``): a card whose pull request's captures wait for the
#: team's review, and cards for « Interroger le tableau » to find.
APP_PROJECT = "Team App"

#: A guide that cites a function the code does not have: the documentation
#: drift the team's analysis finds (``docs-drift`` scenario of the app's spec).
DRIFTED_GUIDE = (
    "# Usage\n\nCall `greet_everyone()` from `app.py` to welcome the whole team.\n"
)


def _seed(
    st: e2e.Stack, people: dict[str, e2e.Person], run: str, repo_url: str
) -> dict[str, str]:
    platform = people["platform"]
    st.login(platform)
    orgs = {
        side: st.ok(
            platform,
            "POST",
            "/admin/orgs",
            json={
                "name": f"App E2E {side.upper()} {run}",
                "slug": f"app-e2e-{side}-{run}",
            },
        )["id"]
        for side in ("a", "b")
    }
    for key, side in (("alice", "a"), ("bob", "a"), ("carol", "b")):
        st.invite(platform, people[key], orgs[side], "member")
        st.login(people[key])
    alice, bob = people["alice"], people["bob"]
    st.ok(
        platform,
        "PATCH",
        f"/admin/members/{alice.user_id}",
        org=orgs["a"],
        json={"role_slug": "admin"},
    )
    projects = {}
    for name, url in (
        (PROJECT_NAME, repo_url),
        (GITHUB_PROJECT, GITHUB_CLONE_URL),
        (GITLAB_PROJECT, GITLAB_CLONE_URL),
        (APP_PROJECT, repo_url),
    ):
        project = st.ok(
            alice, "POST", "/projects", json={"name": name, "repo_url": url}
        )["id"]
        st.ok(
            alice,
            "POST",
            f"/projects/{project}/members",
            json={"user_id": bob.user_id, "role": "member"},
        )
        projects[name] = project
    return projects


PEOPLE = ("alice", "bob", "carol")


@contextmanager
def runs_released(repos_root: Path) -> Iterator[None]:
    """Let every run of the fake agent finish as soon as it starts.

    The fake agent works until a test drops ``e2e-release`` in its spec
    directory (``fake_backend/fake_agent.py``), so that the two-organization
    test can follow a run while it is running. Here nobody holds a run back:
    the apps see it start, write its spec and end, as with a fast model.
    """
    done = threading.Event()

    def release() -> None:
        while not done.wait(0.5):
            for report in repos_root.glob(f"*/.workpilot/specs/*/{REPORT_FILE}"):
                release_file = report.with_name(RELEASE_FILE)
                if not release_file.exists():
                    release_file.write_text("", encoding="utf-8")

    thread = threading.Thread(target=release, daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join(timeout=5)


def _read_passwords() -> dict[str, str]:
    """The spec's passwords, one JSON line on standard input."""
    given = json.loads(sys.stdin.readline() or "{}")
    if not isinstance(given, dict) or not all(
        isinstance(given.get(key), str) and len(given[key]) >= 12 for key in PEOPLE
    ):
        raise SystemExit("expected one JSON line with a password for each person")
    return {key: given[key] for key in PEOPLE}


def main() -> int:
    if e2e.port_in_use(e2e.WS_PORT):
        print(
            f"Port {e2e.WS_PORT} is taken (a local backend?): the streaming server "
            "needs it. Stop it and run again.",
            file=sys.stderr,
        )
        return 2
    passwords = _read_passwords()
    root = Path(tempfile.mkdtemp(prefix="workpilot-app-e2e-"))
    try:
        forge = root / "forge"
        e2e.make_origin_repo(forge, {"docs/usage.md": DRIFTED_GUIDE})
        database = os.environ.get("WORKPILOT_E2E_DATABASE_URL") or (
            f"sqlite+aiosqlite:///{(root / 'server.db').as_posix()}"
        )
        env = e2e.server_env(database, root / "repos")
        # The vault of personal tokens (Settings → My tokens): a key drawn
        # for this run only, gone with it.
        env["WORKPILOT_SECRETS_MASTER_KEY"] = Fernet.generate_key().decode()
        e2e.migrate(env)
        run = e2e.run_suffix()
        people = {key: e2e.new_person(key, run) for key in ("platform", *PEOPLE)}
        for key in PEOPLE:
            people[key].password = passwords[key]
        e2e.create_platform_admin(env, people["platform"])
        with (
            e2e.serve_directory(forge) as forge_url,
            FakeForge(root / "forge-certs") as forges,
            runs_released(root / "repos"),
        ):
            origin = f"{forge_url}/origin.git"
            env.update(forges.env(origin))
            st = e2e.Stack(env, root)
            try:
                st.start()
                projects = _seed(st, people, run, origin)
                cards = seed_app_cards(
                    st, people["alice"], projects[APP_PROJECT], root / "repos"
                )
                world = {
                    "serverUrl": st.base_url,
                    "project": PROJECT_NAME,
                    "githubProject": GITHUB_PROJECT,
                    "gitlabProject": GITLAB_PROJECT,
                    "appProject": APP_PROJECT,
                    # Titles of the cards seeded on its board (``world_cards``).
                    "appCards": cards,
                    # What the fake forges were asked (``GET /calls``).
                    "forgeUrl": forges.url,
                    "emails": {key: people[key].email for key in PEOPLE},
                }
                print(json.dumps(world), flush=True)
                # Serve until the spec closes our standard input.
                sys.stdin.read()
            except Exception:
                print(st.logs(), file=sys.stderr)
                raise
            finally:
                st.stop()
    finally:
        shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
