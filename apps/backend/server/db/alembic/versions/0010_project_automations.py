"""Project automations: a server project's rules and their ledger.

Revision ID: 0010_project_automations
Revises: 0009_user_preferences
Create Date: 2026-11-02

One new table, nothing changed in the existing ones. Like ``0005``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_project_automations"
down_revision = "0009_user_preferences"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("project_automations"):
        return
    op.create_table(
        "project_automations",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("owners", sa.JSON(), nullable=False),
        sa.Column("ledger", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    if _has_table("project_automations"):
        op.drop_table("project_automations")
