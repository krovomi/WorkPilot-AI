"""Which changed files are database migrations, and which engine they run on.

A migration is recognised by where its tool writes it, never by asking the
project to run anything: the path first, then a marker in the file when the
path alone is shared by several tools (`migrations/*.ts` is TypeORM, Knex or
Sequelize). The engine is read from the project's manifests (the ORM's
driver package, Prisma's datasource, Django's settings, Rails'
`database.yml`), never from a `.env` or a connection string, which hold
credentials. An engine that is not clear is ``unknown``: the rules that only
hold on one engine (PostgreSQL's locks) then stay quiet.
"""

from __future__ import annotations

import re
from pathlib import Path

__all__ = ["ENGINES", "detect_engine", "migration_tool", "SQL_TOOLS"]

POSTGRES = "postgres"
MYSQL = "mysql"
SQLSERVER = "sqlserver"
SQLITE = "sqlite"
UNKNOWN = "unknown"
ENGINES = (POSTGRES, MYSQL, SQLSERVER, SQLITE, UNKNOWN)

#: Tools whose migration is plain SQL, and so read with the SQL rules only.
SQL_TOOLS = frozenset(
    {"prisma", "flyway", "golang-migrate", "diesel", "supabase", "drizzle", "sql"}
)

_MAX_MANIFEST_BYTES = 512 * 1024

# (tool, path pattern, marker the file must hold, or None). First match wins.
_BY_PATH: tuple[tuple[str, re.Pattern[str], re.Pattern[str] | None], ...] = (
    (
        "efcore",
        re.compile(
            r"(?:^|/)migrations/(?:[^/]+/)*[^/]+(?<!\.designer)\.cs$", re.IGNORECASE
        ),
        re.compile(r":\s*Migration\b"),
    ),
    ("django", re.compile(r"(?:^|/)migrations/\d{4}_[\w]+\.py$"), None),
    (
        "alembic",
        re.compile(r"(?:^|/)versions/[^/]+\.py$"),
        re.compile(r"\bdef\s+upgrade\s*\("),
    ),
    ("rails", re.compile(r"(?:^|/)db/migrate/\d+_\w+\.rb$"), None),
    ("ecto", re.compile(r"(?:^|/)priv/repo/migrations/[^/]+\.exs$"), None),
    (
        "doctrine",
        re.compile(r"(?:^|/)migrations/(?:[^/]+/)*Version\w+\.php$", re.IGNORECASE),
        re.compile(r"\baddSql\s*\("),
    ),
    ("laravel", re.compile(r"(?:^|/)database/migrations/[^/]+\.php$"), None),
    ("prisma", re.compile(r"(?:^|/)prisma/migrations/[^/]+/migration\.sql$"), None),
    ("supabase", re.compile(r"(?:^|/)supabase/migrations/[^/]+\.sql$"), None),
    ("diesel", re.compile(r"(?:^|/)migrations/[^/]+/up\.sql$"), None),
    ("golang-migrate", re.compile(r"(?:^|/)\d+_[^/]+\.up\.sql$"), None),
    ("flyway", re.compile(r"(?:^|/)V\d+(?:[._]\d+)*__[^/]+\.sql$"), None),
    ("drizzle", re.compile(r"(?:^|/)drizzle/(?:[^/]+/)*\d{4}_[^/]+\.sql$"), None),
)

_NODE_MIGRATION = re.compile(
    r"(?:^|/)migrations?/(?:[^/]+/)*[^/]+\.(?:[cm]?[jt]s)$", re.IGNORECASE
)
_NODE_MARKERS = (
    ("typeorm", re.compile(r"\bqueryRunner\b|MigrationInterface")),
    ("sequelize", re.compile(r"\bqueryInterface\b")),
    ("knex", re.compile(r"\bknex\b|\.schema\.(?:alterTable|table|createTable)\b")),
)
_GENERIC_SQL = re.compile(
    r"(?:^|/)(?:migrations?|migrate|db/changes)/(?:[^/]+/)*[^/]+\.sql$"
)
_DOWN_SQL = re.compile(
    r"(?:^|/)(?:down\.sql|[^/]+\.down\.sql|U\d+(?:[._]\d+)*__[^/]+\.sql)$"
)
_SKIPPED = re.compile(r"(?:ModelSnapshot|\.Designer)\.cs$|(?:^|/)__init__\.py$")


def migration_tool(path: str, read) -> str | None:
    """The tool that wrote the migration at ``path``, or None.

    ``read`` returns the file's text, or "" when it cannot be read; it is
    only called when the path alone does not say which tool it is.
    """
    posix = path.replace("\\", "/")
    if _SKIPPED.search(posix) or _DOWN_SQL.search(posix):
        return None
    for tool, pattern, marker in _BY_PATH:
        if pattern.search(posix):
            if marker is None or marker.search(read(path) or ""):
                return tool
    if _NODE_MIGRATION.search(posix):
        text = read(path) or ""
        if re.search(r"\b(?:up|down)\b", text):
            for tool, marker in _NODE_MARKERS:
                if marker.search(text):
                    return tool
    if _GENERIC_SQL.search(posix):
        return "sql"
    return None


# (engine, marker) read in the manifests below. SQLite next to another engine
# is the local or test database and gives way; two other engines are unknown:
# the guard does not guess which one a migration hits.
_ENGINE_MARKERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        POSTGRES,
        re.compile(
            r"Npgsql|\bpsycopg\d?\b|asyncpg|postgresql_psycopg|backends\.postgresql"
            r"|adapter:\s*postgres|provider\s*=\s*\"postgres(?:ql)?\"|dialect:\s*['\"]postgres"
            r"|\"pg\"\s*:|org\.postgresql|lib/pq|jackc/pgx"
            r"|features\s*=\s*\[[^\]]*\"postgres\"|DB_CONNECTION=pgsql|'pgsql'|postgrex",
            re.IGNORECASE,
        ),
    ),
    (
        MYSQL,
        re.compile(
            r"Pomelo\.EntityFrameworkCore\.MySql|MySql\.EntityFrameworkCore|mysqlclient|pymysql"
            r"|backends\.mysql|adapter:\s*mysql2?|provider\s*=\s*\"mysql\"|dialect:\s*['\"]mysql"
            r"|\"mysql2?\"\s*:|mysql-connector|go-sql-driver/mysql|\"mariadb\"\s*:"
            r"|features\s*=\s*\[[^\]]*\"mysql\"|DB_CONNECTION=mysql|myxql",
            re.IGNORECASE,
        ),
    ),
    (
        SQLSERVER,
        re.compile(
            r"EntityFrameworkCore\.SqlServer|mssql-django|backends\.mssql|adapter:\s*sqlserver"
            r"|provider\s*=\s*\"sqlserver\"|\"(?:mssql|tedious)\"\s*:|mssql-jdbc|go-mssqldb"
            r"|DB_CONNECTION=sqlsrv",
            re.IGNORECASE,
        ),
    ),
    (
        SQLITE,
        re.compile(
            r"EntityFrameworkCore\.Sqlite|backends\.sqlite3|adapter:\s*sqlite3?"
            r"|provider\s*=\s*\"sqlite\"|dialect:\s*['\"](?:sqlite|turso)"
            r"|\"(?:better-sqlite3|sqlite3)\"\s*:|DB_CONNECTION=sqlite|ecto_sqlite3",
            re.IGNORECASE,
        ),
    ),
)

_MANIFESTS = (
    "*.csproj",
    "*/*.csproj",
    "src/*/*.csproj",
    "prisma/schema.prisma",
    "schema.prisma",
    "drizzle.config.*",
    "package.json",
    "pyproject.toml",
    "requirements*.txt",
    "*/settings.py",
    "*/settings/*.py",
    "alembic.ini",
    "config/database.yml",
    "Gemfile",
    "composer.json",
    "config/database.php",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle*",
    "mix.exs",
    "supabase/config.toml",
)


def detect_engine(project_root: Path) -> str:
    """The database engine the project's manifests name, or ``unknown``."""
    root = Path(project_root)
    found: set[str] = set()
    if (root / "supabase" / "config.toml").is_file():
        found.add(POSTGRES)
    for pattern in _MANIFESTS:
        for path in sorted(root.glob(pattern))[:20]:
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                if path.stat().st_size > _MAX_MANIFEST_BYTES:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for engine, marker in _ENGINE_MARKERS:
                if marker.search(text):
                    found.add(engine)
    if len(found) > 1:
        found.discard(SQLITE)
    if len(found) == 1:
        return found.pop()
    return UNKNOWN
