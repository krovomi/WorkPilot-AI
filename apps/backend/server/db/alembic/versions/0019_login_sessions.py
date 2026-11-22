"""Sign-in sessions in the audit log: which sign-in an action was made under.

Revision ID: 0019_login_sessions
Revises: 0018_approval_escalations
Create Date: 2026-11-21

Two nullable columns on ``auth_sessions`` (the sign-in a refresh session
comes from, and how the person signed in) and the same two on ``audit_log``.
Rows written before this revision keep NULL: they named no sign-in. Like
``0017``, each step inspects first, since revision ``0001`` runs
``create_all`` and a newer build may already have the columns.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0019_login_sessions"
down_revision = "0018_approval_escalations"
branch_labels = None
depends_on = None

TABLES = ("auth_sessions", "audit_log")
COLUMNS = (("login_id", 36), ("login_method", 16))


def _missing(table: str) -> list[tuple[str, int]]:
    present = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}
    return [(name, size) for name, size in COLUMNS if name not in present]


def upgrade() -> None:
    for table in TABLES:
        missing = _missing(table)
        if not missing:
            continue
        with op.batch_alter_table(table) as batch:
            for name, size in missing:
                batch.add_column(sa.Column(name, sa.String(length=size), nullable=True))


def downgrade() -> None:
    for table in TABLES:
        gone = dict(_missing(table))
        present = [name for name, _ in COLUMNS if name not in gone]
        if not present:
            continue
        with op.batch_alter_table(table) as batch:
            for name in present:
                batch.drop_column(name)
