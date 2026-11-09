"""The task card's routes: the record, and a check of the task's migrations now."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from qa.schema_guard_api import router


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "shop"
    project.mkdir()
    _git(project, "init", "-q", "-b", "main")
    _git(project, "config", "user.email", "t@example.test")
    _git(project, "config", "user.name", "t")
    (project / "Gemfile").write_text("gem 'pg'\n", encoding="utf-8")
    (project / "config").mkdir()
    (project / "config" / "database.yml").write_text(
        "production:\n  adapter: postgresql\n", encoding="utf-8"
    )
    _git(project, "add", "-A")
    _git(project, "commit", "-q", "-m", "base")
    migrate = project / "db" / "migrate"
    migrate.mkdir(parents=True)
    (migrate / "20261109_add_role.rb").write_text(
        "class AddRole < ActiveRecord::Migration[7.1]\n"
        "  def change\n"
        "    add_index :users, :role\n"
        "  end\n"
        "end\n",
        encoding="utf-8",
    )
    (project / ".workpilot" / "specs" / "001-role").mkdir(parents=True)
    return project


def test_the_card_checks_then_reads_the_record(tmp_path):
    project = _project(tmp_path)
    client = TestClient(FastAPI())
    client.app.include_router(router)  # type: ignore[attr-defined]
    address = {"project_dir": str(project), "spec_id": "001-role"}

    assert client.get("/api/schema-guard/", params=address).json() == {
        "success": True,
        "record": None,
    }
    checked = client.post("/api/schema-guard/check", json=address).json()
    assert checked["success"] is True
    record = checked["record"]
    assert record["status"] == "warn" and record["engine"] == "postgres"
    assert [f["kind"] for f in record["findings"]] == ["lock"]
    assert client.get("/api/schema-guard/", params=address).json()["record"] == record


def test_a_spec_id_that_is_a_path_is_refused(tmp_path):
    project = _project(tmp_path)
    client = TestClient(FastAPI())
    client.app.include_router(router)  # type: ignore[attr-defined]
    answer = client.post(
        "/api/schema-guard/check",
        json={"project_dir": str(project), "spec_id": "../../etc"},
    ).json()
    assert answer["success"] is False and answer["reason"] == "spec_id"
