"""User menu layouts: how a person arranged the desktop's menu, for every desktop.

Revision ID: 0015_user_menu_layouts
Revises: 0014_task_tokens
Create Date: 2026-11-16

One new table, nothing changed in the existing ones. Like ``0009``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015_user_menu_layouts"
down_revision = "0014_task_tokens"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("user_menu_layouts"):
        return
    op.create_table(
        "user_menu_layouts",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("layout", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    if _has_table("user_menu_layouts"):
        op.drop_table("user_menu_layouts")
