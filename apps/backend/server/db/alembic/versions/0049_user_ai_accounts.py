"""A person's AI accounts: several API keys per provider, one the default.

Revision ID: 0049_user_ai_accounts
Revises: 0048_usage_budgets
Create Date: 2026-11-28

One new table, nothing changed in the existing ones. Like ``0048``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0049_user_ai_accounts"
down_revision = "0048_usage_budgets"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("user_ai_accounts"):
        return
    op.create_table(
        "user_ai_accounts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("encrypted_key", sa.Text(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("key_set_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_ai_accounts_user_id", "user_ai_accounts", ["user_id"])


def downgrade() -> None:
    if _has_table("user_ai_accounts"):
        op.drop_table("user_ai_accounts")
