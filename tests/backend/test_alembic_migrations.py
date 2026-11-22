"""The server image runs ``alembic upgrade head`` before it serves: a
migration that fails on a fresh database is a server that never starts.

Revision 0001 creates every table the ORM declares today, so each later
revision must cope with finding its own tables already there.
"""

from __future__ import annotations

from pathlib import Path

import pytest

alembic = pytest.importorskip("alembic")
sa = pytest.importorskip("sqlalchemy")

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

ALEMBIC_INI = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "server"
    / "db"
    / "alembic.ini"
)


@pytest.fixture
def alembic_config(tmp_path, monkeypatch):
    db = tmp_path / "server.sqlite3"
    monkeypatch.setenv("WORKPILOT_DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    return Config(str(ALEMBIC_INI)), db


def _tables(db: Path) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        return set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_upgrade_head_on_a_fresh_database(alembic_config):
    from server.db.models import Base

    config, db = alembic_config
    command.upgrade(config, "head")

    assert set(Base.metadata.tables) <= _tables(db)


def test_downgrade_to_base_then_upgrade_again(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    command.downgrade(config, "base")

    assert _tables(db) <= {"alembic_version"}

    command.upgrade(config, "head")
    assert "invitations" in _tables(db)


def test_a_database_from_before_task_tokens_gains_their_columns(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    command.downgrade(config, "0013_access_tokens")
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        columns = {c["name"] for c in sa.inspect(engine).get_columns("access_tokens")}
        assert "project_id" not in columns and "card_id" not in columns
        engine.dispose()
        command.upgrade(config, "head")
        inspector = sa.inspect(engine)
        columns = {c["name"] for c in inspector.get_columns("access_tokens")}
        assert {"project_id", "card_id"} <= columns
        assert any(
            fk["referred_table"] == "projects"
            for fk in inspector.get_foreign_keys("access_tokens")
        )
    finally:
        engine.dispose()


def test_the_approval_tables_come_and_go_with_their_revision(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    approvals = {"spec_criticality", "spec_approvals", "approval_delegations"}
    assert approvals <= _tables(db)
    # A table already gone (dropped by hand) does not stop the downgrade.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE spec_criticality"))
    finally:
        engine.dispose()
    command.downgrade(config, "0015_user_menu_layouts")
    assert not approvals & _tables(db)
    command.upgrade(config, "head")
    assert approvals <= _tables(db)


def test_the_replay_shares_table_comes_and_goes_with_its_revision(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    assert "replay_shares" in _tables(db)
    command.downgrade(config, "0016_spec_approvals")
    assert "replay_shares" not in _tables(db)
    command.upgrade(config, "head")
    assert "replay_shares" in _tables(db)
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        indexes = {i["name"] for i in sa.inspect(engine).get_indexes("replay_shares")}
    finally:
        engine.dispose()
    assert "ix_replay_shares_project" in indexes
    # A table already gone (dropped by hand) does not stop the downgrade.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE replay_shares"))
    finally:
        engine.dispose()
    command.downgrade(config, "0016_spec_approvals")
    assert "replay_shares" not in _tables(db)


def test_the_escalations_table_comes_and_goes_with_its_revision(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    assert "approval_escalations" in _tables(db)
    command.downgrade(config, "0017_replay_shares")
    assert "approval_escalations" not in _tables(db)
    # A table already there (``create_all`` of a newer build) is kept.
    command.upgrade(config, "0018_approval_escalations")
    command.downgrade(config, "0017_replay_shares")
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text("CREATE TABLE approval_escalations (run_id VARCHAR(36))")
            )
    finally:
        engine.dispose()
    command.upgrade(config, "head")
    assert "approval_escalations" in _tables(db)
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE approval_escalations"))
    finally:
        engine.dispose()
    command.downgrade(config, "0017_replay_shares")
    assert "approval_escalations" not in _tables(db)


def test_the_leaderboard_consents_table_comes_and_goes_with_its_revision(
    alembic_config,
):
    config, db = alembic_config
    command.upgrade(config, "head")
    assert "leaderboard_consents" in _tables(db)
    command.downgrade(config, "0019_login_sessions")
    assert "leaderboard_consents" not in _tables(db)
    # A table already there (``create_all`` of a newer build) is kept.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text("CREATE TABLE leaderboard_consents (org_id VARCHAR(36))")
            )
    finally:
        engine.dispose()
    command.upgrade(config, "head")
    assert "leaderboard_consents" in _tables(db)
    # A table already gone (dropped by hand) does not stop the downgrade.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE leaderboard_consents"))
    finally:
        engine.dispose()
    command.downgrade(config, "0019_login_sessions")
    assert "leaderboard_consents" not in _tables(db)


def _columns(db: Path, table: str) -> set[str]:
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        return {c["name"] for c in sa.inspect(engine).get_columns(table)}
    finally:
        engine.dispose()


def test_the_sign_in_columns_come_and_go_with_their_revision(alembic_config):
    config, db = alembic_config
    command.upgrade(config, "head")
    login = {"login_id", "login_method"}
    for table in ("auth_sessions", "audit_log"):
        assert login <= _columns(db, table)
    command.downgrade(config, "0018_approval_escalations")
    for table in ("auth_sessions", "audit_log"):
        assert not login & _columns(db, table)
    # A database that has one of them already gets the other one only.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text("ALTER TABLE audit_log ADD COLUMN login_id VARCHAR(36)")
            )
    finally:
        engine.dispose()
    command.upgrade(config, "head")
    assert login <= _columns(db, "audit_log")
    # A table that lost them both is left as it is on the way down.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("ALTER TABLE audit_log DROP COLUMN login_id"))
            connection.execute(
                sa.text("ALTER TABLE audit_log DROP COLUMN login_method")
            )
    finally:
        engine.dispose()
    command.downgrade(config, "0018_approval_escalations")
    assert not login & _columns(db, "auth_sessions")
