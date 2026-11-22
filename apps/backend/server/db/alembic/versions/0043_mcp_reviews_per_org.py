"""MCP server reviews: shared within the organization, no longer per project.

Revision ID: 0043_mcp_reviews_per_org
Revises: 0042_usage_records
Create Date: 2026-11-22

A team review of a catalogue MCP server (#369) was kept with the project it
was written in; it now belongs to the project's organization, read by every
project of it and by no other organization. The table is rebuilt with an
``org_id`` (the project's) and one review per person, organization and
server: where a person reviewed the same server in two projects of one
organization, the latest review is kept. ``project_id`` stays, emptied when
its project is deleted, so a downgrade can put each review back in it.

Like ``0041``, the step inspects first: revision ``0001`` runs
``create_all``, so a database created by a newer build already has the new
shape, and an upgrade leaves it as it is. The rebuilt table is created
under another name, then renamed: its key and constraints are named so that
they never meet those of the table it replaces (PostgreSQL keeps an index
name once per schema).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0043_mcp_reviews_per_org"
down_revision = "0042_usage_records"
branch_labels = None
depends_on = None

_TABLE = "mcp_server_reviews"
_NEW = "mcp_server_reviews_rebuilt"

_COMMON = ("server_id", "author_id", "author_name", "verdict", "comment")
_TIMES = ("created_at", "updated_at")


def _columns() -> set[str] | None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return None
    return {column["name"] for column in inspector.get_columns(_TABLE)}


def _shared_columns() -> list[sa.Column]:
    return [
        sa.Column("server_id", sa.String(length=100), nullable=False),
        sa.Column("author_id", sa.String(length=36), nullable=True),
        sa.Column("author_name", sa.String(length=200), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
    ]


def _create_org_table(name: str) -> None:
    op.create_table(
        name,
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        *_shared_columns(),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name="pk_mcp_org_review"),
        sa.UniqueConstraint(
            "org_id", "server_id", "author_id", name="uq_mcp_org_review"
        ),
    )


def _create_project_table(name: str) -> None:
    """The shape of ``0041``: one review per person, project and server."""
    op.create_table(
        name,
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        *_shared_columns(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_mcp_project_review"),
        sa.UniqueConstraint(
            "project_id", "server_id", "author_id", name="uq_mcp_review"
        ),
    )


_MOVED = ", ".join((*_COMMON, *_TIMES))
_FROM_OLD = ", ".join(f"r.{name}" for name in (*_COMMON, *_TIMES))


def upgrade() -> None:
    columns = _columns()
    if columns is not None and "org_id" in columns:
        return
    _create_org_table(_NEW)
    if columns is not None:
        # The latest review of each person, server and organization; one
        # whose author is gone is kept as it is (NULLs are never equal).
        op.execute(
            f"""
            INSERT INTO {_NEW} (id, org_id, project_id, {_MOVED})
            SELECT r.id, p.org_id, r.project_id, {_FROM_OLD}
            FROM {_TABLE} r JOIN projects p ON p.id = r.project_id
            WHERE r.author_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM {_TABLE} o JOIN projects q ON q.id = o.project_id
                WHERE q.org_id = p.org_id
                  AND o.server_id = r.server_id
                  AND o.author_id = r.author_id
                  AND (o.updated_at > r.updated_at
                       OR (o.updated_at = r.updated_at AND o.id > r.id))
            )
            """
        )
        op.drop_table(_TABLE)
    op.rename_table(_NEW, _TABLE)
    op.create_index("ix_mcp_server_reviews_org", _TABLE, ["org_id", "server_id"])


def downgrade() -> None:
    columns = _columns()
    if columns is None or "org_id" not in columns:
        return
    _create_project_table(_NEW)
    # Each review goes back to the project it was last written from; one
    # whose project is gone had no place before this revision either.
    op.execute(
        f"""
        INSERT INTO {_NEW} (id, project_id, {_MOVED})
        SELECT r.id, r.project_id, {_FROM_OLD}
        FROM {_TABLE} r WHERE r.project_id IS NOT NULL
        """
    )
    op.drop_table(_TABLE)
    op.rename_table(_NEW, _TABLE)
    op.create_index(
        "ix_mcp_server_reviews_project", _TABLE, ["project_id", "server_id"]
    )
