"""Replay shares: how many bookmarks each shared session carries.

Revision ID: 0020_replay_share_bookmarks
Revises: 0017_replay_shares
Create Date: 2026-11-21

One nullable column on ``replay_shares``, read by the project's usage figures
(the share of shared replays that are annotated); a share made before it
stays unknown. Like ``0014``, the step inspects first: revision ``0001`` runs
``create_all``, so a database created by a newer build may already have it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020_replay_share_bookmarks"
down_revision = "0017_replay_shares"
branch_labels = None
depends_on = None


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "replay_shares" not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns("replay_shares")}


def upgrade() -> None:
    columns = _columns()
    if not columns or "bookmarks" in columns:
        return
    with op.batch_alter_table("replay_shares") as batch:
        batch.add_column(sa.Column("bookmarks", sa.Integer(), nullable=True))


def downgrade() -> None:
    if "bookmarks" not in _columns():
        return
    with op.batch_alter_table("replay_shares") as batch:
        batch.drop_column("bookmarks")
