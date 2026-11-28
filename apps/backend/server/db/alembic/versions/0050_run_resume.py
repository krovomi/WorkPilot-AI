"""Runs a server restart interrupted, and the offer to resume them.

Revision ID: 0050_run_resume
Revises: 0049_user_ai_accounts
Create Date: 2026-11-28

Two columns on ``agent_runs``: ``started_approved`` (a build that started with
a valid approval of its plan, so its resume keeps it) and
``resume_answered_at`` (when someone resumed the interrupted run or set it
aside, so it is not offered again). Neither names a person. Rows written
before this revision read false and NULL. Like ``0019``, each step inspects
first, since revision ``0001`` runs ``create_all`` and a newer build may
already have the columns.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0050_run_resume"
down_revision = "0049_user_ai_accounts"
branch_labels = None
depends_on = None

TABLE = "agent_runs"


def _columns() -> list[sa.Column]:
    return [
        sa.Column(
            "started_approved",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("resume_answered_at", sa.DateTime(timezone=True), nullable=True),
    ]


def _present() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    present = _present()
    missing = [column for column in _columns() if column.name not in present]
    if not missing:
        return
    with op.batch_alter_table(TABLE) as batch:
        for column in missing:
            batch.add_column(column)


def downgrade() -> None:
    present = _present()
    gone = [column.name for column in _columns() if column.name in present]
    if not gone:
        return
    with op.batch_alter_table(TABLE) as batch:
        for name in gone:
            batch.drop_column(name)
