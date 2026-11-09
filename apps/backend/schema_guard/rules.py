"""What a migration does to a live database, read from its text.

Zero model, zero connection: each rule is a pattern over the migration's
``up`` part (never its ``down``, where a ``DROP`` is the rollback of a
``CREATE``), in the tool's own API or in the SQL it runs. A finding names
what goes wrong while the old code still runs next to the new schema, and
the zero-downtime way to do it on that engine and with that tool.

Kinds:

- ``data_loss``: a table or a column dropped, a table truncated.
- ``rename``: a table or a column renamed; the running code still uses the
  old name.
- ``type_change``: a column's type changed; the table may be rewritten and a
  value that does not convert is lost.
- ``not_null``: a NOT NULL column added without a default to an existing
  table (fails on the first row), or NOT NULL set on a column (a full scan
  under lock on PostgreSQL).
- ``lock``: PostgreSQL only, on a table the migration did not create: an index
  built without ``CONCURRENTLY``, a foreign key or check validated at once.
- ``no_rollback``: a tool with a down migration, and none is written.
- ``edited``: a migration that existed before the task was changed or
  deleted; it may already have run somewhere.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from .discover import POSTGRES, SQL_TOOLS

__all__ = [
    "DATA_LOSS",
    "EDITED",
    "ERROR",
    "Finding",
    "KINDS",
    "LOCK",
    "NOT_NULL",
    "NO_ROLLBACK",
    "RENAME",
    "TYPE_CHANGE",
    "WARNING",
    "analyse",
]

DATA_LOSS = "data_loss"
RENAME = "rename"
TYPE_CHANGE = "type_change"
NOT_NULL = "not_null"
LOCK = "lock"
NO_ROLLBACK = "no_rollback"
EDITED = "edited"
KINDS = (DATA_LOSS, RENAME, TYPE_CHANGE, NOT_NULL, LOCK, NO_ROLLBACK, EDITED)

ERROR = "error"
WARNING = "warning"

_I = re.IGNORECASE | re.DOTALL


@dataclass(frozen=True)
class Finding:
    kind: str
    severity: str
    path: str
    line: int
    statement: str
    message: str
    advice: str

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "path": self.path,
            "line": self.line,
            "statement": self.statement,
            "message": self.message,
            "advice": self.advice,
        }


@dataclass(frozen=True)
class _Rule:
    kind: str
    severity: str
    pattern: re.Pattern[str]
    message: str
    unless: re.Pattern[str] | None = None
    when: re.Pattern[str] | None = None
    check: Callable[[str], bool] | None = None
    table: re.Pattern[str] | None = None
    postgres_only: bool = False


def _r(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, _I)


# ---------------------------------------------------------------- advice

_ADVICE = {
    DATA_LOSS: (
        "Expand/contract: ship the code that no longer reads or writes it first, "
        "keep the data (or a backup) through a cooldown, then drop it in a later "
        "migration."
    ),
    RENAME: (
        "Add the new name next to the old one, write both, backfill, switch the "
        "reads, then drop the old one in a later migration: a rename breaks every "
        "running instance that still uses the old name."
    ),
    TYPE_CHANGE: (
        "Add a column of the new type, backfill it in batches with a checked "
        "conversion (a value that does not convert is reported, not lost), "
        "switch the code, then drop the old column."
    ),
    NOT_NULL: (
        "Add the column nullable or with a default, backfill in batches, then "
        "add the NOT NULL constraint in a later migration."
    ),
    NO_ROLLBACK: (
        "Write the down migration (the exact reverse), or say in the migration "
        "why it cannot be reversed and how the data is restored."
    ),
    EDITED: (
        "This migration existed before the task and may already have run "
        "somewhere: restore it and add a new migration for the change."
    ),
}

_SET_NOT_NULL = (
    "On PostgreSQL, add CHECK (column IS NOT NULL) NOT VALID, then VALIDATE "
    "CONSTRAINT, then SET NOT NULL: it uses the check and skips the scan under "
    "lock."
)

_CONCURRENTLY = {
    "django": "use AddIndexConcurrently (django.contrib.postgres.operations) in a migration with atomic = False",
    "alembic": "pass postgresql_concurrently=True inside op.get_context().autocommit_block()",
    "rails": "add algorithm: :concurrently and disable_ddl_transaction! to the migration",
    "efcore": 'write it with migrationBuilder.Sql("CREATE INDEX CONCURRENTLY ...", suppressTransaction: true)',
    "laravel": "run DB::statement('CREATE INDEX CONCURRENTLY ...') in a migration with public $withinTransaction = false",
    "knex": "use knex.raw('CREATE INDEX CONCURRENTLY ...') with exports.config = { transaction: false }",
    "sequelize": "pass { concurrently: true } to addIndex, outside a transaction",
    "typeorm": "run CREATE INDEX CONCURRENTLY with queryRunner.query, in a migration with transaction = false",
    "ecto": "pass concurrently: true, with @disable_ddl_transaction true and @disable_migration_lock true",
}

_NOT_VALID = {
    "django": "use AddConstraintNotValid then ValidateConstraint (django.contrib.postgres.operations)",
    "alembic": "pass postgresql_not_valid=True, then VALIDATE CONSTRAINT in the next migration",
    "rails": "pass validate: false, then validate_foreign_key in the next migration",
    "ecto": "pass validate: false, then execute VALIDATE CONSTRAINT in the next migration",
}


def _lock_advice(tool: str, index: bool) -> str:
    if index:
        recipe = _CONCURRENTLY.get(
            tool,
            "use CREATE INDEX CONCURRENTLY, outside a transaction, in a migration of its own",
        )
        return f"Building the index blocks writes to the table until it ends; {recipe}."
    recipe = _NOT_VALID.get(
        tool, "add it NOT VALID, then VALIDATE CONSTRAINT in a separate migration"
    )
    return (
        "Validating the constraint at once locks the table while every row is "
        f"checked; {recipe}."
    )


def _advice(finding_kind: str, severity: str, tool: str, message: str) -> str:
    if finding_kind == LOCK:
        return _lock_advice(tool, "index" in message)
    if finding_kind == NOT_NULL and severity == WARNING:
        return _SET_NOT_NULL
    return _ADVICE[finding_kind]


# ---------------------------------------------------------------- SQL rules

_TABLE = r"(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<table>[\w.\"`\[\]]+)"
_COLUMN_NOT_SPECIAL = (
    r"(?!(?:CONSTRAINT|INDEX|KEY|DEFAULT|NOT|IDENTITY|PRIMARY|FOREIGN|CHECK|"
    r"TRIGGER|PERIOD|EXPRESSION|UNIQUE|PARTITION)\b)"
)

_SQL_RULES: tuple[_Rule, ...] = (
    _Rule(DATA_LOSS, ERROR, _r(r"^\s*DROP\s+TABLE\b"), "drops a table and its data"),
    _Rule(
        DATA_LOSS,
        ERROR,
        _r(
            rf"^\s*ALTER\s+TABLE\s+{_TABLE}.*?\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"
            rf"{_COLUMN_NOT_SPECIAL}[\w\"`\[]"
        ),
        "drops a column and its data",
    ),
    _Rule(DATA_LOSS, ERROR, _r(r"^\s*TRUNCATE\b"), "empties a table"),
    _Rule(
        RENAME,
        ERROR,
        _r(
            rf"^\s*ALTER\s+TABLE\s+{_TABLE}.*?\b(?:RENAME|CHANGE\s+(?:COLUMN\s+)?[\w`\"]+\s+[\w`\"]+)\b"
            r"|\bsp_rename\b|^\s*RENAME\s+TABLE\b"
        ),
        "renames a table or a column",
        unless=_r(r"\bRENAME\s+(?:CONSTRAINT|INDEX|KEY)\b"),
    ),
    _Rule(
        TYPE_CHANGE,
        WARNING,
        _r(
            r"^\s*ALTER\s+TABLE\b.*?(?:\bALTER\s+(?:COLUMN\s+)?[\w\"`]+\s+(?:SET\s+DATA\s+)?TYPE\b"
            r"|\bALTER\s+COLUMN\s+[\w\"`\[\].]+\s+(?!SET\b|DROP\b|ADD\b|RESTART\b|RESET\b|OPTIONS\b)\w"
            r"|\bMODIFY\s+(?:COLUMN\s+)?[\w`]+\s+\w)"
        ),
        "changes a column's type",
    ),
    _Rule(
        NOT_NULL,
        ERROR,
        _r(
            rf"^\s*ALTER\s+TABLE\s+{_TABLE}.*?\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"
            r"(?!(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY)\b)[\w\"`\[\]]+\s+[^,]*?\bNOT\s+NULL\b"
        ),
        "adds a NOT NULL column without a default to an existing table",
        unless=_r(r"\bDEFAULT\b|\bGENERATED\b|\bIDENTITY\b"),
    ),
    _Rule(
        NOT_NULL,
        WARNING,
        _r(rf"^\s*ALTER\s+TABLE\s+{_TABLE}.*?\bSET\s+NOT\s+NULL\b"),
        "sets NOT NULL on a column, a full scan under lock",
        postgres_only=True,
    ),
    _Rule(
        LOCK,
        WARNING,
        _r(
            r"^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)(?:\s+IF\s+NOT\s+EXISTS)?"
            r"(?:\s+[\w\"]+)?\s+ON\s+(?:ONLY\s+)?(?P<table>[\w.\"]+)"
        ),
        "builds an index without CONCURRENTLY",
        postgres_only=True,
    ),
    _Rule(
        LOCK,
        WARNING,
        _r(
            rf"^\s*ALTER\s+TABLE\s+{_TABLE}.*?\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:FOREIGN\s+KEY|CHECK)\b"
        ),
        "adds a constraint validated at once",
        unless=_r(r"\bNOT\s+VALID\b"),
        postgres_only=True,
    ),
)

_SQL_CREATED = _r(
    r"^\s*CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>[\w.\"`\[\]]+)"
)
_SQL_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/|#[^\n]*(?=\n|$)", re.DOTALL)


# ---------------------------------------------------------------- ORM rules


def _differs(first: str, second: str) -> Callable[[str], bool]:
    a, b = re.compile(first), re.compile(second)

    def check(unit: str) -> bool:
        x, y = a.search(unit), b.search(unit)
        return bool(x and y and x.group(1).lower() != y.group(1).lower())

    return check


_ORM_RULES: dict[str, tuple[_Rule, ...]] = {
    "efcore": (
        _Rule(DATA_LOSS, ERROR, _r(r"\.DropTable\s*\("), "drops a table and its data"),
        _Rule(
            DATA_LOSS, ERROR, _r(r"\.DropColumn\s*\("), "drops a column and its data"
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\.Rename(?:Column|Table)\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\.AlterColumn\s*<"),
            "changes a column's type",
            check=_differs(r'\btype:\s*"([^"]+)"', r'\boldType:\s*"([^"]+)"'),
        ),
        _Rule(
            NOT_NULL,
            WARNING,
            _r(r"\.AlterColumn\s*<"),
            "sets NOT NULL on a column, a full scan under lock",
            when=_r(
                r"\bnullable:\s*false\b.*\boldNullable:\s*true\b|\boldNullable:\s*true\b.*\bnullable:\s*false\b"
            ),
            table=_r(r'\btable:\s*"(\w+)"'),
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\.AddColumn\s*<"),
            "adds a NOT NULL column without a default to an existing table",
            when=_r(r"\bnullable:\s*false\b"),
            unless=_r(r"\bdefaultValue(?:Sql)?:|\bcomputedColumnSql:"),
            table=_r(r'\btable:\s*"(\w+)"'),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.CreateIndex\s*\("),
            "builds an index without CONCURRENTLY",
            table=_r(r'\btable:\s*"(\w+)"'),
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.AddForeignKey\s*\("),
            "adds a constraint validated at once",
            table=_r(r'\btable:\s*"(\w+)"'),
            postgres_only=True,
        ),
    ),
    "django": (
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bmigrations\.DeleteModel\s*\("),
            "drops a table and its data",
        ),
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bmigrations\.RemoveField\s*\("),
            "drops a column and its data",
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\bmigrations\.Rename(?:Field|Model)\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\bmigrations\.AlterField\s*\("),
            "changes a column's definition",
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\bmigrations\.AddField\s*\("),
            "adds a NOT NULL column without a default to an existing table",
            unless=_r(
                r"\bnull\s*=\s*True|\bdefault\s*=|\bdb_default\s*=|ManyToManyField|GeneratedField"
            ),
            table=_r(r"\bmodel_name\s*=\s*['\"](\w+)"),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\bmigrations\.AddIndex\s*\("),
            "builds an index without CONCURRENTLY",
            table=_r(r"\bmodel_name\s*=\s*['\"](\w+)"),
            postgres_only=True,
        ),
        _Rule(
            NO_ROLLBACK,
            WARNING,
            _r(r"\bmigrations\.RunPython\s*\("),
            "runs code with no reverse",
            unless=_r(r"\breverse_code\s*=|RunPython\s*\(\s*[\w.]+\s*,\s*[\w.]+"),
        ),
        _Rule(
            NO_ROLLBACK,
            WARNING,
            _r(r"\bmigrations\.RunSQL\s*\("),
            "runs SQL with no reverse",
            unless=_r(
                r"\breverse_sql\s*=|RunSQL\s*\(\s*(?:sql\s*=\s*)?"
                r"(?:\[.*?\]|\"\"\".*?\"\"\"|'''.*?'''|\"[^\"]*\"|'[^']*')\s*,\s*\S"
            ),
        ),
    ),
    "alembic": (
        _Rule(
            DATA_LOSS, ERROR, _r(r"\bop\.drop_table\s*\("), "drops a table and its data"
        ),
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bop\.drop_column\s*\("),
            "drops a column and its data",
        ),
        _Rule(
            RENAME, ERROR, _r(r"\bop\.rename_table\s*\("), "renames a table or a column"
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\bop\.alter_column\s*\("),
            "renames a table or a column",
            when=_r(r"\bnew_column_name\s*="),
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\bop\.alter_column\s*\("),
            "changes a column's type",
            when=_r(r"\btype_\s*="),
        ),
        _Rule(
            NOT_NULL,
            WARNING,
            _r(r"\bop\.alter_column\s*\("),
            "sets NOT NULL on a column, a full scan under lock",
            when=_r(r"\bnullable\s*=\s*False"),
            table=_r(r"alter_column\s*\(\s*['\"](\w+)"),
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\bop\.add_column\s*\("),
            "adds a NOT NULL column without a default to an existing table",
            when=_r(r"\bnullable\s*=\s*False"),
            unless=_r(r"\bserver_default\s*=|\bComputed\s*\(|\bIdentity\s*\("),
            table=_r(r"add_column\s*\(\s*['\"](\w+)"),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\bop\.create_index\s*\("),
            "builds an index without CONCURRENTLY",
            unless=_r(r"\bpostgresql_concurrently\s*=\s*True"),
            table=_r(r"create_index\s*\(\s*[^,]+,\s*['\"](\w+)"),
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\bop\.create_(?:foreign_key|check_constraint)\s*\("),
            "adds a constraint validated at once",
            unless=_r(r"\bpostgresql_not_valid\s*=\s*True"),
            table=_r(r"create_\w+\s*\(\s*[^,]+,\s*['\"](\w+)"),
            postgres_only=True,
        ),
    ),
    "rails": (
        _Rule(DATA_LOSS, ERROR, _r(r"\bdrop_table\b"), "drops a table and its data"),
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bremove_(?:column|columns|reference|belongs_to|timestamps)\b"),
            "drops a column and its data",
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\brename_(?:column|table)\b"),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\bchange_column\b(?!_null|_default|_comment)"),
            "changes a column's type",
        ),
        _Rule(
            NOT_NULL,
            WARNING,
            _r(r"\bchange_column_null\b[^\n]*,\s*false\b"),
            "sets NOT NULL on a column, a full scan under lock",
            table=_r(r"change_column_null\s*\(?\s*[:\"'](\w+)"),
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\badd_column\b"),
            "adds a NOT NULL column without a default to an existing table",
            when=_r(r"\bnull:\s*false\b"),
            unless=_r(r"\bdefault:"),
            table=_r(r"add_column\s*\(?\s*[:\"'](\w+)"),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\badd_index\b"),
            "builds an index without CONCURRENTLY",
            unless=_r(r"\balgorithm:\s*:concurrently\b"),
            table=_r(r"add_index\s*\(?\s*[:\"'](\w+)"),
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\badd_(?:foreign_key|check_constraint)\b"),
            "adds a constraint validated at once",
            unless=_r(r"\bvalidate:\s*false\b"),
            table=_r(r"add_\w+\s*\(?\s*[:\"'](\w+)"),
            postgres_only=True,
        ),
    ),
    "laravel": (
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bSchema::drop(?:IfExists)?\s*\("),
            "drops a table and its data",
        ),
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(
                r"->drop(?:Column|Columns|ConstrainedForeignId|Timestamps\w*|SoftDeletes\w*|Morphs)\s*\("
            ),
            "drops a column and its data",
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"->renameColumn\s*\(|\bSchema::rename\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"->change\s*\(\s*\)"),
            "changes a column's definition",
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(
                r"\$table->(?:string|char|text|mediumText|longText|tinyText|integer|tinyInteger|smallInteger"
                r"|mediumInteger|bigInteger|unsigned\w*|decimal|double|float|boolean|date|dateTime\w*|time"
                r"|timeTz|timestamp|timestampTz|year|json|jsonb|uuid|ulid|binary|enum|set|ipAddress"
                r"|macAddress|foreignId|foreignUuid|foreignUlid)\s*\("
            ),
            "adds a NOT NULL column without a default to an existing table",
            unless=_r(
                r"->nullable\s*\(|->default\s*\(|->useCurrent\s*\(|->change\s*\(|->storedAs\s*\("
                r"|->virtualAs\s*\(|->autoIncrement\s*\("
            ),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(
                r"\$table->(?:index|unique|fullText|spatialIndex)\s*\(|->(?:index|unique)\s*\(\s*\)"
            ),
            "builds an index without CONCURRENTLY",
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\$table->foreign\s*\(|->constrained\s*\("),
            "adds a constraint validated at once",
            postgres_only=True,
        ),
    ),
    "knex": (
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\.dropTable(?:IfExists)?\s*\("),
            "drops a table and its data",
        ),
        _Rule(
            DATA_LOSS, ERROR, _r(r"\.dropColumns?\s*\("), "drops a column and its data"
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\.rename(?:Column|Table)\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\.alter\s*\(\s*\)"),
            "changes a column's definition",
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\.notNullable\s*\(\s*\)"),
            "adds a NOT NULL column without a default to an existing table",
            unless=_r(r"\.defaultTo\s*\(|\.alter\s*\("),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.(?:index|unique)\s*\("),
            "builds an index without CONCURRENTLY",
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.(?:foreign|references)\s*\("),
            "adds a constraint validated at once",
            postgres_only=True,
        ),
    ),
    "sequelize": (
        _Rule(DATA_LOSS, ERROR, _r(r"\.dropTable\s*\("), "drops a table and its data"),
        _Rule(
            DATA_LOSS, ERROR, _r(r"\.removeColumn\s*\("), "drops a column and its data"
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\.rename(?:Column|Table)\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\.changeColumn\s*\("),
            "changes a column's definition",
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\.addColumn\s*\("),
            "adds a NOT NULL column without a default to an existing table",
            when=_r(r"\ballowNull:\s*false\b"),
            unless=_r(r"\bdefaultValue:"),
            table=_r(r"addColumn\s*\(\s*['\"`](\w+)"),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.addIndex\s*\("),
            "builds an index without CONCURRENTLY",
            unless=_r(r"\bconcurrently:\s*true\b"),
            table=_r(r"addIndex\s*\(\s*['\"`](\w+)"),
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.addConstraint\s*\("),
            "adds a constraint validated at once",
            table=_r(r"addConstraint\s*\(\s*['\"`](\w+)"),
            postgres_only=True,
        ),
    ),
    "typeorm": (
        _Rule(DATA_LOSS, ERROR, _r(r"\.dropTable\s*\("), "drops a table and its data"),
        _Rule(
            DATA_LOSS, ERROR, _r(r"\.dropColumns?\s*\("), "drops a column and its data"
        ),
        _Rule(
            RENAME,
            ERROR,
            _r(r"\.rename(?:Column|Table)\s*\("),
            "renames a table or a column",
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\.changeColumns?\s*\("),
            "changes a column's definition",
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.createIndex\s*\("),
            "builds an index without CONCURRENTLY",
            table=_r(r"createIndex\s*\(\s*['\"`](\w+)"),
            postgres_only=True,
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\.createForeignKeys?\s*\("),
            "adds a constraint validated at once",
            table=_r(r"createForeignKeys?\s*\(\s*['\"`](\w+)"),
            postgres_only=True,
        ),
    ),
    "ecto": (
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bdrop(?:_if_exists)?\s+table\s*\("),
            "drops a table and its data",
        ),
        _Rule(
            DATA_LOSS,
            ERROR,
            _r(r"\bremove(?:_if_exists)?\s+:\w+"),
            "drops a column and its data",
        ),
        _Rule(
            RENAME, ERROR, _r(r"\brename\s+table\s*\("), "renames a table or a column"
        ),
        _Rule(
            TYPE_CHANGE,
            WARNING,
            _r(r"\bmodify\s+:\w+"),
            "changes a column's definition",
        ),
        _Rule(
            NOT_NULL,
            ERROR,
            _r(r"\badd(?:_if_not_exists)?\s+:\w+"),
            "adds a NOT NULL column without a default to an existing table",
            when=_r(r"\bnull:\s*false\b"),
            unless=_r(r"\bdefault:"),
        ),
        _Rule(
            LOCK,
            WARNING,
            _r(r"\bcreate(?:_if_not_exists)?\s+(?:unique_)?index\s*\("),
            "builds an index without CONCURRENTLY",
            unless=_r(r"\bconcurrently:\s*true\b"),
            table=_r(r"index\s*\(\s*:(\w+)"),
            postgres_only=True,
        ),
    ),
    "doctrine": (),
}

# Where a tool names a table it creates, or the table a block of statements
# works on: (created?, regex). Only the tools of `_SCOPED` open a block (Rails'
# `change_table`, Laravel's `Schema::table`…); elsewhere it is one call.
_BLOCKS: dict[str, tuple[tuple[bool, re.Pattern[str]], ...]] = {
    "efcore": ((True, _r(r"\.CreateTable\s*\(\s*name:\s*\"(\w+)\"")),),
    "django": ((True, _r(r"\bmigrations\.CreateModel\s*\(\s*name\s*=\s*['\"](\w+)")),),
    "alembic": ((True, _r(r"\bop\.create_table\s*\(\s*['\"](\w+)")),),
    "rails": (
        (True, _r(r"\bcreate_table\s*\(?\s*[:\"'](\w+)")),
        (False, _r(r"\bchange_table\s*\(?\s*[:\"'](\w+)")),
    ),
    "laravel": (
        (True, _r(r"\bSchema::create\s*\(\s*['\"](\w+)")),
        (False, _r(r"\bSchema::table\s*\(\s*['\"](\w+)")),
    ),
    "knex": (
        (True, _r(r"\.createTable(?:IfNotExists)?\s*\(\s*['\"`](\w+)")),
        (False, _r(r"\.(?:alterTable|table)\s*\(\s*['\"`](\w+)")),
    ),
    "sequelize": ((True, _r(r"\.createTable\s*\(\s*['\"`](\w+)")),),
    "typeorm": ((True, _r(r"new\s+Table\s*\(\s*\{\s*name:\s*['\"`](\w+)")),),
    "ecto": (
        (True, _r(r"\bcreate(?:_if_not_exists)?\s+table\s*\(\s*:(\w+)")),
        (False, _r(r"\balter\s+table\s*\(\s*:(\w+)")),
    ),
}

_SCOPED = frozenset({"rails", "laravel", "knex", "ecto"})

# Where the up and the down parts start, per tool with a down migration. The
# up marker that is a reversible `change` writes no down on purpose.
_PARTS: dict[str, tuple[re.Pattern[str], re.Pattern[str]]] = {
    "efcore": (
        _r(r"\boverride\s+void\s+Up\s*\("),
        _r(r"\boverride\s+void\s+Down\s*\("),
    ),
    "alembic": (_r(r"\bdef\s+upgrade\s*\("), _r(r"\bdef\s+downgrade\s*\(")),
    "rails": (re.compile(r"\bdef\s+(?:up|change)\b"), re.compile(r"\bdef\s+down\b")),
    "ecto": (re.compile(r"\bdef\s+(?:up|change)\b"), re.compile(r"\bdef\s+down\b")),
    "laravel": (_r(r"\bfunction\s+up\s*\("), _r(r"\bfunction\s+down\s*\(")),
    "doctrine": (_r(r"\bfunction\s+up\s*\("), _r(r"\bfunction\s+down\s*\(")),
    "typeorm": (re.compile(r"\bup\b\s*[:=(]"), re.compile(r"\bdown\b\s*[:=(]")),
    "knex": (re.compile(r"\bup\b\s*[:=(]"), re.compile(r"\bdown\b\s*[:=(]")),
    "sequelize": (re.compile(r"\bup\b\s*[:=(]"), re.compile(r"\bdown\b\s*[:=(]")),
}
_REVERSIBLE = re.compile(r"\bdef\s+change\b")
_NOISE = frozenset(
    "pass end return void async await function fn def do self this public protected"
    " override export const let var any string true false none null undefined promise"
    " resolve migrationbuilder queryrunner queryinterface sequelize knex schema"
    " schemabuilder"
    " type typeof connection".split()
)
_WORD = re.compile(r"[A-Za-z_]\w*")
_CODE_COMMENT = re.compile(
    r"#[^\n]*|//[^\n]*|/\*.*?\*/|\"\"\".*?\"\"\"|'''.*?'''", re.DOTALL
)

_SQL_STRINGS = (
    re.compile(r"@\"((?:[^\"]|\"\")*)\""),
    re.compile(r"\"\"\"(.*?)\"\"\"", re.DOTALL),
    re.compile(r"'''(.*?)'''", re.DOTALL),
    re.compile(r"`((?:[^`\\]|\\.)*)`", re.DOTALL),
    re.compile(r"<<<?[~-]?['\"]?(\w+)['\"]?\n(.*?)\n\s*\1\b", re.DOTALL),
    re.compile(r"\"((?:[^\"\\\n]|\\.)*)\""),
    re.compile(r"'((?:[^'\\\n]|\\.)*)'"),
)
_SQL_START = _r(r"^\s*(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|EXEC(?:UTE)?\s+sp_rename)\b")


# ---------------------------------------------------------------- reading


def _norm(table: str | None) -> str:
    if not table:
        return ""
    return re.sub(r"[\"`\[\]]", "", table).rsplit(".", 1)[-1].lower()


def _line(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _snippet(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:200]


def _unit(text: str, start: int, limit: int = 4000) -> str:
    """The call or statement starting at ``start``: brackets balanced, then
    up to the end of its line or its ``;``."""
    depth = 0
    seen_open = False
    quote = ""
    end = min(len(text), start + limit)
    i = start
    while i < end:
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch in "'\"`":
            quote = ch
        elif ch in "([{":
            depth += 1
            seen_open = True
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return text[start:i]
        elif depth == 0 and (ch == ";" or (ch == "\n" and (seen_open or i > start))):
            if ch == "\n" and re.match(r"\s*\.", text[i:]):
                i += 1
                continue
            return text[start:i]
        i += 1
    return text[start:end]


def _parts(tool: str, text: str) -> tuple[int, str, str | None, bool]:
    """(offset of up, up text, down text or None, whether up is reversible)."""
    markers = _PARTS.get(tool)
    if markers is None:
        return 0, text, None, False
    up_at, down_at = markers[0].search(text), markers[1].search(text)
    if up_at is None:
        return 0, text, None, False
    start = up_at.start()
    if down_at is None:
        return start, text[start:], None, bool(_REVERSIBLE.match(up_at.group(0)))
    if down_at.start() > start:
        return start, text[start : down_at.start()], text[down_at.end() :], False
    return start, text[start:], text[down_at.end() : start], False


def _empty_body(down: str) -> bool:
    stripped = _CODE_COMMENT.sub(" ", down)
    return not any(w.lower() not in _NOISE for w in _WORD.findall(stripped))


def _sql_statements(sql: str, base: int):
    """(offset, statement) of each ``;``-separated statement, comments blanked."""
    blank = _SQL_COMMENT.sub(lambda m: " " * len(m.group(0)), sql)
    for match in re.finditer(r"[^;]+", blank):
        if match.group(0).strip():
            yield (
                base
                + match.start()
                + (len(match.group(0)) - len(match.group(0).lstrip())),
                match.group(0).strip(),
            )


def _sql_strings(text: str):
    """(offset, SQL) of every string literal of ``text`` that holds DDL."""
    taken: list[tuple[int, int]] = []
    for pattern in _SQL_STRINGS:
        for match in pattern.finditer(text):
            if any(a <= match.start() < b for a, b in taken):
                continue
            group = match.lastindex or 0
            body = match.group(group)
            if _SQL_START.match(body):
                taken.append((match.start(), match.end()))
                yield match.start(group), body.replace('""', '"')


class _Context:
    def __init__(self, path: str, tool: str, engine: str, text: str) -> None:
        self.path, self.tool, self.engine, self.text = path, tool, engine, text
        self.findings: list[Finding] = []
        self.created: set[str] = set()
        self.blocks: list[tuple[int, bool, str]] = []

    def add(self, rule: _Rule, offset: int, unit: str, table: str) -> None:
        if rule.kind in (NOT_NULL, LOCK) and table and table in self.created:
            return
        self.findings.append(
            Finding(
                kind=rule.kind,
                severity=rule.severity,
                path=self.path,
                line=_line(self.text, offset),
                statement=_snippet(unit),
                message=rule.message,
                advice=_advice(rule.kind, rule.severity, self.tool, rule.message),
            )
        )

    def block_at(self, offset: int) -> tuple[bool, str] | None:
        current = None
        for start, created, table in self.blocks:
            if start > offset:
                break
            current = (created, table)
        return current


def _apply(ctx: _Context, rules, unit_text: str, offset: int, unit: str) -> None:
    for rule in rules:
        if rule.postgres_only and ctx.engine != POSTGRES:
            continue
        match = rule.pattern.search(unit_text)
        if match is None:
            continue
        if rule.unless is not None and rule.unless.search(unit):
            continue
        if rule.when is not None and not rule.when.search(unit):
            continue
        if rule.check is not None and not rule.check(unit):
            continue
        table = ""
        if "table" in rule.pattern.groupindex:
            table = _norm(match.group("table"))
        elif rule.table is not None:
            found = rule.table.search(unit)
            table = _norm(found.group(1)) if found else ""
        ctx.add(rule, offset, unit, table)


def _sql(ctx: _Context, sql: str, base: int) -> None:
    statements = list(_sql_statements(sql, base))
    for _, statement in statements:
        created = _SQL_CREATED.match(statement)
        if created:
            ctx.created.add(_norm(created.group("table")))
    for offset, statement in statements:
        _apply(ctx, _SQL_RULES, statement, offset, statement)


def analyse(path: str, text: str, tool: str, engine: str) -> list[Finding]:
    """What the ``up`` part of one migration does that an expand/contract would not."""
    ctx = _Context(path, tool, engine, text)
    if tool in SQL_TOOLS:
        _sql(ctx, text, 0)
        return ctx.findings
    start, up, down, reversible = _parts(tool, text)
    for created, pattern in _BLOCKS.get(tool, ()):
        for match in pattern.finditer(up):
            table = _norm(match.group(1))
            if tool in _SCOPED:
                ctx.blocks.append((start + match.start(), created, table))
            if created:
                ctx.created.add(table)
    ctx.blocks.sort()
    for offset, sql in _sql_strings(up):
        _sql(ctx, sql, start + offset)
    for rule in _ORM_RULES.get(tool, ()):
        for match in rule.pattern.finditer(up):
            offset = start + match.start()
            block = ctx.block_at(offset)
            table = None if rule.table is not None else (block[1] if block else "")
            _apply_one(ctx, rule, _unit(up, match.start()), offset, table)
    if tool in _PARTS and not reversible:
        if down is None:
            ctx.findings.append(_no_down(ctx, start, "has no down migration"))
        elif _empty_body(down):
            ctx.findings.append(_no_down(ctx, start, "has an empty down migration"))
    return ctx.findings


def _apply_one(
    ctx: _Context, rule: _Rule, unit: str, offset: int, table: str | None
) -> None:
    if rule.postgres_only and ctx.engine != POSTGRES:
        return
    if rule.unless is not None and rule.unless.search(unit):
        return
    if rule.when is not None and not rule.when.search(unit):
        return
    if rule.check is not None and not rule.check(unit):
        return
    if table is None:
        found = rule.table.search(unit) if rule.table is not None else None
        table = _norm(found.group(1)) if found else ""
    ctx.add(rule, offset, unit, table)


def _no_down(ctx: _Context, offset: int, message: str) -> Finding:
    return Finding(
        kind=NO_ROLLBACK,
        severity=WARNING,
        path=ctx.path,
        line=_line(ctx.text, offset),
        statement="",
        message=message,
        advice=_ADVICE[NO_ROLLBACK],
    )
