"""Password resets: single-use links to set a new local password.

Revision ID: 0044_password_resets
Revises: 0043_mcp_reviews_per_org
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0042``, the step
inspects first (it follows `0043_mcp_reviews_per_org`, merged the same day): revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0044_password_resets"
down_revision = "0043_mcp_reviews_per_org"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("password_resets"):
        return
    op.create_table(
        "password_resets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_password_resets_user_id", "password_resets", ["user_id"])
    op.create_index(
        "ix_password_resets_token_hash", "password_resets", ["token_hash"], unique=True
    )


def downgrade() -> None:
    if _has_table("password_resets"):
        op.drop_index("ix_password_resets_token_hash", table_name="password_resets")
        op.drop_index("ix_password_resets_user_id", table_name="password_resets")
        op.drop_table("password_resets")
