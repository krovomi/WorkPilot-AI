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
