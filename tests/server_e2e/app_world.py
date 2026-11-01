"""A server for the desktop app's end-to-end spec, seeded with two teams.

``apps/frontend/e2e/server-mode.server-e2e.ts`` starts this script, reads one
JSON line from its standard output, drives the built app against the server
it names, and closes the script's standard input when it is done; the script
then stops the server and removes everything it made.

The server is ``stack.py``'s (migrations, streaming server, API under uvicorn,
a fake agent in place of the model) on a SQLite database in a temporary
directory, unless ``WORKPILOT_E2E_DATABASE_URL`` names another one. Two
organizations: in the first, Alice (its administrator, who registers the
project) and Bob (a member of the project); in the second, Carol. The
passwords are drawn at random for this run and only travel through the pipe
to the spec, never into a file.

Usage, from the repository root: ``python -m tests.server_e2e.app_world``.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from tests.server_e2e import stack as e2e

PROJECT_NAME = "Team Board"


def _seed(
    st: e2e.Stack, people: dict[str, e2e.Person], run: str, repo_url: str
) -> None:
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
    project = st.ok(
        alice, "POST", "/projects", json={"name": PROJECT_NAME, "repo_url": repo_url}
    )["id"]
    st.ok(
        alice,
        "POST",
        f"/projects/{project}/members",
        json={"user_id": bob.user_id, "role": "member"},
    )


def main() -> int:
    if e2e.port_in_use(e2e.WS_PORT):
        print(
            f"Port {e2e.WS_PORT} is taken (a local backend?): the streaming server "
            "needs it. Stop it and run again.",
            file=sys.stderr,
        )
        return 2
    root = Path(tempfile.mkdtemp(prefix="workpilot-app-e2e-"))
    try:
        forge = root / "forge"
        e2e.make_origin_repo(forge)
        database = os.environ.get("WORKPILOT_E2E_DATABASE_URL") or (
            f"sqlite+aiosqlite:///{(root / 'server.db').as_posix()}"
        )
        env = e2e.server_env(database, root / "repos")
        e2e.migrate(env)
        run = e2e.run_suffix()
        people = {
            key: e2e.new_person(key, run)
            for key in ("platform", "alice", "bob", "carol")
        }
        e2e.create_platform_admin(env, people["platform"])
        with e2e.serve_directory(forge) as forge_url:
            st = e2e.Stack(env, root)
            try:
                st.start()
                _seed(st, people, run, f"{forge_url}/origin.git")
                world = {
                    "serverUrl": st.base_url,
                    "project": PROJECT_NAME,
                    "people": {
                        key: {"email": p.email, "password": p.password}
                        for key, p in people.items()
                        if key != "platform"
                    },
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
