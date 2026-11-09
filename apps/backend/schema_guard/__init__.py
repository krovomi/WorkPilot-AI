"""The schema guard: zero-downtime review of a task's database migrations.

Static and deterministic (no model, no connection to a database), so it runs
the same on every provider and every stack: EF Core, Django, Alembic, Rails,
Laravel, Doctrine, Knex, Sequelize, TypeORM, Ecto, and the SQL migrations of
Prisma, Drizzle, Flyway, golang-migrate, Diesel and Supabase. See
docs/architecture/schema-guard.md.
"""

from __future__ import annotations

from .discover import detect_engine, migration_tool
from .guard import (
    FAIL,
    PASS,
    RECORD,
    UNCHECKED,
    WARN,
    SchemaReport,
    check,
    load_record,
    write_record,
)
from .rules import ERROR, KINDS, WARNING, Finding, analyse

__all__ = [
    "ERROR",
    "FAIL",
    "KINDS",
    "PASS",
    "RECORD",
    "UNCHECKED",
    "WARN",
    "WARNING",
    "Finding",
    "SchemaReport",
    "analyse",
    "check",
    "detect_engine",
    "load_record",
    "migration_tool",
    "write_record",
]
