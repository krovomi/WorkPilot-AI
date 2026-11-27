"""Page activity: how often each person opened each page, per day.

Revision ID: 0046_page_visits
Revises: 0045_presence_days
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0042``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0046_page_visits"
down_revision = "0045_presence_days"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("page_visits"):
        return
    op.create_table(
        "page_visits",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("client", sa.String(length=10), nullable=False),
        sa.Column("page", sa.String(length=60), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "org_id", "day", "client", "page", name="uq_page_visit"
        ),
    )
    op.create_index("ix_page_visit_org_day", "page_visits", ["org_id", "day"])


def downgrade() -> None:
    if _has_table("page_visits"):
        op.drop_index("ix_page_visit_org_day", table_name="page_visits")
        op.drop_table("page_visits")
