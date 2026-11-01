"""Deployment markers: one-time steps a deployment has already taken.

Revision ID: 0007_deployment_markers
Revises: 0006_insight_sessions
Create Date: 2026-11-01

One new table. Like ``0006``, the step inspects first: revision ``0001`` runs
``create_all``, so a database created by a newer build may already have it.

Revision ``0003`` moved the users of a single-tenant deployment into the
default organization before this table existed, so this revision records that
step as taken: the server start (``server.db.seed.bootstrap_deployment``) then
never runs it again on this database.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_deployment_markers"
down_revision = "0006_insight_sessions"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    if not _has_table("deployment_markers"):
        op.create_table(
            "deployment_markers",
            sa.Column("key", sa.String(length=100), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("key"),
        )

    from server.db.seed import PRE_MULTI_TENANT_BACKFILL, record_marker

    record_marker(op.get_bind(), PRE_MULTI_TENANT_BACKFILL)


def downgrade() -> None:
    if _has_table("deployment_markers"):
        op.drop_table("deployment_markers")
