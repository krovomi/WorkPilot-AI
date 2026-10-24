"""Invitations table (invitation-only self-service signup).

Revision ID: 0002_invitations
Revises: 0001_initial
Create Date: 2026-06-11

Revision ``0001`` creates every table the ORM declares *today*, invitations
included, so on a fresh database this table already exists when this revision
runs. It therefore inspects before it acts, like ``0003``.
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_invitations"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def _has_index(table: str, index: str) -> bool:
    return index in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    if _has_table("invitations"):
        for name, columns in (
            ("ix_invitations_email", ["email"]),
            ("ix_invitations_token_hash", ["token_hash"]),
        ):
            if not _has_index("invitations", name):
                op.create_index(name, "invitations", columns)
        return
    op.create_table(
        "invitations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("invited_by", sa.String(length=36), nullable=True),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("project_role", sa.String(length=20), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["invited_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash", name="uq_invitation_token_hash"),
    )
    op.create_index("ix_invitations_email", "invitations", ["email"])
    op.create_index("ix_invitations_token_hash", "invitations", ["token_hash"])


def downgrade() -> None:
    op.drop_index("ix_invitations_token_hash", table_name="invitations")
    op.drop_index("ix_invitations_email", table_name="invitations")
    op.drop_table("invitations")
