"""Task tokens: an access token bound to one project and one card.

Revision ID: 0014_task_tokens
Revises: 0013_access_tokens
Create Date: 2026-11-07

Two nullable columns on ``access_tokens``; a personal token keeps both empty.
Like ``0013``, the step inspects first: revision ``0001`` runs ``create_all``,
so a database created by a newer build may already have them.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_task_tokens"
down_revision = "0013_access_tokens"
branch_labels = None
depends_on = None


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "access_tokens" not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns("access_tokens")}


def upgrade() -> None:
    columns = _columns()
    if not columns or "project_id" in columns:
        return
    with op.batch_alter_table("access_tokens") as batch:
        batch.add_column(sa.Column("project_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("card_id", sa.String(length=120), nullable=True))
        batch.create_foreign_key(
            "fk_access_tokens_project_id",
            "projects",
            ["project_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_index("ix_access_tokens_project_id", ["project_id"])


def downgrade() -> None:
    if "project_id" not in _columns():
        return
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("access_tokens")
    }
    # Dropping the column drops its foreign key, named or not (``create_all``
    # in ``0001`` names none).
    with op.batch_alter_table("access_tokens") as batch:
        if "ix_access_tokens_project_id" in indexes:
            batch.drop_index("ix_access_tokens_project_id")
        batch.drop_column("card_id")
        batch.drop_column("project_id")
