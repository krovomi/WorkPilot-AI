"""Health check, Prometheus and migration detection of the watch (#366)."""

from __future__ import annotations

import subprocess
import urllib.error
import urllib.request

import pytest
from deploy_watch import collectors
from deploy_watch.collectors import health_check, prometheus_value
from deploy_watch.migrations import changed_paths, migration_files

PROM = "https://prom.example"


def _vector(*values: str) -> dict:
    return {
        "status": "success",
        "data": {"resultType": "vector", "result": [{"value": [0, v]} for v in values]},
    }


class TestHealthCheck:
    def test_statuses(self, fake_fetch):
        assert health_check("https://a/h", fake_fetch({"https://a/h": (200, b"ok")})).ok
        assert health_check("https://a/h", fake_fetch({"https://a/h": (302, b"")})).ok
        failed = health_check("https://a/h", fake_fetch({"https://a/h": (503, b"")}))
        assert (failed.ok, failed.status) == (False, 503)

    def test_unreachable(self, fake_fetch):
        result = health_check("https://a/h", fake_fetch({}))
        assert (result.ok, result.error) == (False, "OSError")


class TestPrometheus:
    def test_vector_sum_and_scalar(self, fake_fetch):
        fetch = fake_fetch({PROM: (200, _vector("1.5", "2"))})
        assert prometheus_value(PROM, "tok-0000", "up", fetch) == 3.5
        request = fetch.requests[0]
        assert request.full_url.startswith(f"{PROM}/api/v1/query?query=up")
        assert request.get_header("Authorization") == "Bearer tok-0000"
        scalar = fake_fetch(
            {PROM: (200, {"data": {"resultType": "scalar", "result": [0, "4"]}})}
        )
        assert prometheus_value(PROM, "", "x", scalar) == 4.0
        assert scalar.requests[0].get_header("Authorization") is None

    def test_token_never_sent_in_clear_to_a_remote_host(self, fake_fetch):
        fetch = fake_fetch({"http://prom.example": (200, _vector("1"))})
        prometheus_value("http://prom.example", "tok-0000", "x", fetch)
        assert fetch.requests[0].get_header("Authorization") is None
        local = fake_fetch({"http://127.0.0.1:9090": (200, _vector("1"))})
        prometheus_value("http://127.0.0.1:9090", "tok-0000", "x", local)
        assert local.requests[0].get_header("Authorization") == "Bearer tok-0000"

    @pytest.mark.parametrize(
        "answer",
        [
            (500, _vector("1")),
            (200, b"not json"),
            (200, _vector()),
            (200, _vector("NaN")),
            (200, _vector("+Inf")),
            (200, {"data": {"resultType": "vector", "result": [{"nope": 1}]}}),
            (200, {"data": None}),
            (200, b"x" * (collectors.MAX_BODY_BYTES + 1)),
            OSError("down"),
        ],
    )
    def test_nothing_usable(self, fake_fetch, answer):
        assert prometheus_value(PROM, "", "x", fake_fetch({PROM: answer})) is None


class TestDefaultFetch:
    def test_reads_status_and_body(self, monkeypatch):
        class Response:
            status = 200

            def read(self, limit):
                return b"ok"[:limit]

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        calls = []

        def fake_open(request, timeout):
            calls.append(timeout)
            return Response()

        monkeypatch.setattr(collectors._OPENER, "open", fake_open)
        assert collectors.default_fetch(urllib.request.Request("https://a")) == (
            200,
            b"ok",
        )
        assert calls == [collectors.TIMEOUT_SECONDS]

    def test_http_error_is_a_status(self, monkeypatch):
        def fake_open(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 404, "nope", {}, None)  # type: ignore[arg-type]

        monkeypatch.setattr(collectors._OPENER, "open", fake_open)
        assert collectors.default_fetch(urllib.request.Request("https://a")) == (
            404,
            b"",
        )

    def test_redirects_are_not_followed(self):
        handler = collectors._NoRedirect()
        assert (
            handler.redirect_request(None, None, 302, "Found", {}, "https://elsewhere")
            is None
        )


class TestMigrations:
    @pytest.mark.parametrize(
        "path",
        [
            "app/alembic/versions/1234_add.py",
            "shop/migrations/0002_order.py",
            "migrations/20261115_add.sql",
            "migrations/2026-11-15-000_add/up.sql",
            "db/migrate/20261115_add.rb",
            "database/migrations/2026_add.php",
            "Data\\Migrations\\20261115_Add.cs",
            "src/main/resources/db/migration/V2_1__add.sql",
            "db/changelog/changes.xml",
            "prisma/migrations/20261115/migration.sql",
            "priv/repo/migrations/20261115_add.exs",
            "drizzle/0001_add.sql",
            "app/schemas/com.example.Db/3.json",
            "src/1700000000000-add.migration.ts",
        ],
    )
    def test_every_stack(self, path):
        assert migration_files([path]) == [path.replace("\\", "/")]

    def test_not_a_migration(self):
        assert migration_files(["src/app.py", "docs/migrations.md", "README.md"]) == []


def _git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    (tmp_path / "app.py").write_text("x = 1\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "one")
    first = _git(tmp_path, "rev-parse", "HEAD")
    (tmp_path / "migrations").mkdir()
    (tmp_path / "migrations" / "0002_add.py").write_text("y = 2\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "two")
    return tmp_path, first, _git(tmp_path, "rev-parse", "HEAD")


class TestChangedPaths:
    def test_lists_the_change(self, repo):
        path, first, second = repo
        assert changed_paths(path, first, second) == ["migrations/0002_add.py"]

    def test_unknown(self, repo, monkeypatch):
        path, first, second = repo
        assert changed_paths(path, "main", second) is None
        assert changed_paths(path, "a" * 40, second) is None

        import deploy_watch.migrations as migrations

        real = migrations.run_git

        def failing_diff(args, cwd=None):
            if args[0] == "diff":
                return subprocess.CompletedProcess(args, 1, "", "boom")
            return real(args, cwd=cwd)

        monkeypatch.setattr(migrations, "run_git", failing_diff)
        assert changed_paths(path, first, second) is None
