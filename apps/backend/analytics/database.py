"""
Database connection and session management for Build Analytics.
"""

import logging
import os
from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .database_schema import Base

logger = logging.getLogger(__name__)


def _default_database_url() -> str:
    # Anchor the SQLite file to <repo_root>/data so it works regardless of cwd.
    repo_root = Path(__file__).resolve().parents[3]
    db_path = repo_root / "data" / "analytics.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.as_posix()}"


# Database configuration
DATABASE_URL = os.getenv("ANALYTICS_DATABASE_URL", _default_database_url())

# Create engine
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
else:
    engine = create_engine(DATABASE_URL, echo=False)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def create_tables():
    """Create all database tables."""
    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Get database session, rolling back on errors and always closing."""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


_state = {"initialized": False}


def init_database():
    """Initialize the analytics database (once per process: several entry
    points call it at startup)."""
    if _state["initialized"]:
        return
    create_tables()
    _state["initialized"] = True
    logger.debug("Analytics database initialized")
