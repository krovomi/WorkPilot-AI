"""Does a change hold a database migration? Every stack (#366).

A rollback of the code does not undo a migration already applied: the old
code then runs against the new schema. So a change between the last good
deployment and this one that adds a migration file blocks the automatic
rollback and says why. The patterns cover the migration tools of the stacks
WorkPilot builds: Alembic, Django, Rails, Laravel, Entity Framework, Flyway,
Liquibase, Prisma, Knex, Sequelize, TypeORM, Ecto, golang-migrate, goose,
Diesel, sqlx, Doctrine, Phinx, DbUp, Room, Drizzle.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from foundation.git_executable import run_git

_PATTERNS = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"(^|/)alembic/versions/[^/]+\.py$",
        r"(^|/)migrations/[^/]+\.(py|sql|js|ts|mjs|cjs|go|rb|php|cs|ex|exs|kt|java|rs)$",
        r"(^|/)migrations/[^/]+/(up|down|migration)\.sql$",
        r"(^|/)db/migrate/[^/]+\.rb$",
        r"(^|/)database/migrations/[^/]+\.php$",
        r"(^|/)Migrations/[^/]+\.(cs|php)$",
        r"(^|/)V\d+([._]\d+)*__[^/]+\.sql$",
        r"(^|/)db/changelog/",
        r"(^|/)prisma/migrations/",
        r"(^|/)priv/repo/migrations/",
        r"(^|/)drizzle/[^/]+\.sql$",
        r"(^|/)schemas/[^/]+/\d+\.json$",
        r"\.migration\.(ts|js)$",
    )
)

_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")


def migration_files(paths: Iterable[str]) -> list[str]:
    found: list[str] = []
    for path in paths:
        posix = path.replace("\\", "/")
        if any(p.search(posix) for p in _PATTERNS):
            found.append(posix)
    return found


def changed_paths(project_dir: Path, base: str, head: str) -> list[str] | None:
    """Files changed from `base` to `head` in the local clone; None when unknown.

    Both must be commit ids already in the clone: nothing is fetched.
    """
    if not (_SHA.match(base) and _SHA.match(head)):
        return None
    for sha in (base, head):
        if run_git(["cat-file", "-e", f"{sha}^{{commit}}"], cwd=project_dir).returncode:
            return None
    result = run_git(["diff", "--name-only", base, head, "--"], cwd=project_dir)
    if result.returncode:
        return None
    return [line for line in result.stdout.splitlines() if line.strip()]
