"""MCP server reviews: a project team's security reviews of catalogue servers.

Revision ID: 0041_mcp_server_reviews
Revises: 0019_login_sessions
Create Date: 2026-11-22

One new table, nothing changed in the existing ones. Like ``0017``, the step
inspects first: revision ``0001`` runs ``create_all``, so a database created
by a newer build may already have it. Numbered 0041 to stay clear of the
revisions open branches add after 0019; it is re-chained on whichever of
them lands first.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0041_mcp_server_reviews"
down_revision = "0019_login_sessions"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if _has_table("mcp_server_reviews"):
        return
    op.create_table(
        "mcp_server_reviews",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("server_id", sa.String(length=100), nullable=False),
        sa.Column("author_id", sa.String(length=36), nullable=True),
        sa.Column("author_name", sa.String(length=200), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "server_id", "author_id", name="uq_mcp_review"
        ),
    )
    op.create_index(
        "ix_mcp_server_reviews_project",
        "mcp_server_reviews",
        ["project_id", "server_id"],
    )


def downgrade() -> None:
    if _has_table("mcp_server_reviews"):
        op.drop_index("ix_mcp_server_reviews_project", table_name="mcp_server_reviews")
        op.drop_table("mcp_server_reviews")
