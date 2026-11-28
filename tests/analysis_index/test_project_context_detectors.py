"""What the project index says about a service beyond its stack: environment,
external services, auth, migrations, background jobs, API docs, monitoring.
Each case is a small project written on disk, read by ``ContextAnalyzer``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from analysis.analyzers.context_analyzer import ContextAnalyzer
from analysis.analyzers.port_detector import PortDetector


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


def _context(
    root: Path, files: dict[str, str], analysis: dict | None = None
) -> tuple[ContextAnalyzer, dict]:
    analysis = {} if analysis is None else analysis
    return ContextAnalyzer(_write(root, files), analysis), analysis


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------


def test_environment_from_examples_compose_and_code(tmp_path: Path) -> None:
    service = tmp_path / "api"
    context, analysis = _context(
        service,
        {
            ".env.sample": "# comment\n\nexport API_URL=\nDEBUG=\n",
            "config.py": (
                'import os\nDB = os.environ["DB_HOST"]\nx = os.getenv("DB_HOST")\n'
                'y = os.environ.get("FEATURE_X")\nz = os.getenv("DEBUG")\n'
            ),
            "index.ts": "const t = process.env.SESSION_TOKEN\n",
        },
    )
    _write(
        tmp_path,
        {
            "docker-compose.yml": (
                "services:\n  api:\n    environment:\n      - QUEUE_URL=amqp://q\n"
                "      - DB_PASSWORD\n    image: x\n  worker:\n    environment:\n"
                "      CACHE_TTL: 30\n      # note\n      REDIS_HOST: r\n  other:\n    image: y\n"
            )
        },
    )

    context.detect_environment_variables()
    env = analysis["environment"]
    variables = env["variables"]

    assert variables["API_URL"] == {
        "value": None,
        "source": ".env.example",
        "type": "string",
        "sensitive": False,
        "required": True,
    }
    assert variables["DEBUG"]["source"] == ".env.example"
    # The compose file one level up, list and mapping forms; a password by
    # name is sensitive (it was always listed as not sensitive).
    assert variables["QUEUE_URL"]["source"] == "../docker-compose.yml"
    assert variables["DB_PASSWORD"]["sensitive"] is True
    assert {"CACHE_TTL", "REDIS_HOST"} <= set(variables)
    # Regression: os.environ["X"] raises without X, so X is required.
    assert variables["DB_HOST"]["required"] is True
    assert variables["FEATURE_X"]["required"] is False
    assert variables["SESSION_TOKEN"] == {
        "value": None,
        "source": "code:index.ts",
        "type": "string",
        "sensitive": True,
        "required": False,
    }
    assert env["required_count"] == 3
    assert env["optional_count"] == 2
    assert env["detected_count"] == len(variables)


def test_compose_environment_ends_at_the_next_key(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path,
        {
            "docker-compose.yml": (
                "services:\n  api:\n    environment:\n    - A_ONE=1\n    ports:\n"
                '      - "8000:8000"\n    labels:\n      NOT_ENV: x\n'
            )
        },
    )

    context.detect_environment_variables()

    assert set(analysis["environment"]["variables"]) == {"A_ONE"}


def test_value_types_are_inferred(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path,
        {
            ".env": (
                "FLAG=yes\nWORKERS=4\nSITE=https://example.test\nADMIN=ops@example.test\n"
                "DATA_DIR=/var/data\nWIN_DIR=C:\\\\data\nNAME=api\nEMPTY=\n"
            )
        },
    )

    context.detect_environment_variables()
    types = {k: v["type"] for k, v in analysis["environment"]["variables"].items()}

    assert types == {
        "FLAG": "boolean",
        "WORKERS": "number",
        "SITE": "url",
        "ADMIN": "email",
        "DATA_DIR": "path",
        "WIN_DIR": "path",
        "NAME": "string",
        "EMPTY": "string",
    }


def test_no_environment_leaves_the_analysis_alone(tmp_path: Path) -> None:
    context, analysis = _context(tmp_path, {"README.md": "x"})

    context.detect_environment_variables()

    assert "environment" not in analysis


# --------------------------------------------------------------------------
# Services, auth
# --------------------------------------------------------------------------


def test_external_services_by_category(tmp_path: Path) -> None:
    deps = {
        "pg": "1",
        "redis": "1",
        "bullmq": "1",
        "@sendgrid/mail": "1",
        "stripe": "1",
        "@aws-sdk/client-s3": "1",
        "jsonwebtoken": "1",
        "@sentry/node": "1",
    }
    context, analysis = _context(
        tmp_path, {"package.json": json.dumps({"dependencies": deps})}
    )

    context.detect_external_services()
    services = analysis["services"]

    assert services["databases"] == [
        {"type": "postgresql", "client": "pg"},
        {"type": "redis", "client": "redis"},
    ]
    assert services["cache"] == [{"type": "redis"}]
    assert services["message_queues"] == [{"type": "bullmq", "client": "bullmq"}]
    assert services["email"] == [{"provider": "sendgrid", "client": "@sendgrid/mail"}]
    assert services["payments"] == [{"provider": "stripe", "client": "stripe"}]
    assert services["storage"] == [
        {"provider": "aws_s3", "client": "@aws-sdk/client-s3"}
    ]
    assert services["auth_providers"] == [{"type": "jwt", "client": "jsonwebtoken"}]
    assert services["monitoring"] == [{"type": "sentry", "client": "@sentry/node"}]


def test_no_service_leaves_the_analysis_alone(tmp_path: Path) -> None:
    context, analysis = _context(tmp_path, {"package.json": "{}"})

    context.detect_external_services()

    assert "services" not in analysis


def test_auth_strategies_user_model_and_decorators(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path,
        {
            "requirements.txt": "PyJWT==2\nAuthlib\nFlask-Login\n",
            "models/user.py": "class User: ...\n",
            "views.py": "@login_required\ndef a(): ...\n@require_admin\ndef b(): ...\n",
            "plain.py": "def c(): ...\n",
            "broken.py": b"\xff\xfe".decode("latin-1"),
        },
    )
    (tmp_path / "bad.py").write_bytes(b"\xff\xfe@login_required")

    context.detect_auth_patterns()
    auth = analysis["auth"]

    assert auth["strategies"] == ["jwt", "oauth", "session"]
    assert auth["libraries"] == ["pyjwt", "authlib", "flask-login"]
    assert auth["user_model"] == "models/user.py"
    assert auth["middleware"] == ["login_required", "require_admin"]


def test_no_auth_library_leaves_the_analysis_alone(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path, {"package.json": json.dumps({"dependencies": {"left-pad": "1"}})}
    )

    context.detect_auth_patterns()

    assert "auth" not in analysis


# --------------------------------------------------------------------------
# Migrations
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        ({"alembic.ini": ""}, {"tool": "alembic", "directory": "alembic"}),
        (
            {"alembic/versions/.keep": ""},
            {"tool": "alembic", "directory": "alembic/versions"},
        ),
        (
            {"manage.py": "", "shop/migrations/0001.py": "", "migrations.py": ""},
            {"tool": "django", "directories": ["shop/migrations"]},
        ),
        ({"knexfile.ts": ""}, {"tool": "knex", "config_file": "knexfile.ts"}),
        ({"data-source.ts": ""}, {"tool": "typeorm", "directory": "migrations"}),
        (
            {"prisma/schema.prisma": ""},
            {"tool": "prisma", "directory": "prisma/migrations"},
        ),
    ],
    ids=["alembic", "alembic versions", "django", "knex", "typeorm", "prisma"],
)
def test_migration_tools(tmp_path: Path, files: dict[str, str], expected: dict) -> None:
    context, analysis = _context(tmp_path, files)

    context.detect_migrations()

    assert expected.items() <= analysis["migrations"].items()
    assert analysis["migrations"]["commands"]


def test_django_without_migrations_has_none(tmp_path: Path) -> None:
    context, analysis = _context(tmp_path, {"manage.py": ""})

    context.detect_migrations()

    assert "migrations" not in analysis


# --------------------------------------------------------------------------
# Background jobs
# --------------------------------------------------------------------------


def test_celery_tasks(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path,
        {
            "app/tasks.py": "@shared_task\ndef send(): ...\n@app.task(bind=True)\ndef bill(self): ...\n",
            "app/celery.py": "app = Celery()\n",
        },
    )
    (tmp_path / "other" / "tasks.py").parent.mkdir()
    (tmp_path / "other" / "tasks.py").write_bytes(b"\xff\xfe")

    context.detect_background_jobs()

    assert analysis["background_jobs"] == {
        "system": "celery",
        "tasks": [
            {"name": "send", "file": "app/tasks.py"},
            {"name": "bill", "file": "app/tasks.py"},
        ],
        "total_tasks": 2,
        "worker_command": "celery -A app worker",
    }


@pytest.mark.parametrize(
    ("files", "system"),
    [
        (
            {"tasks.py": "def not_a_task(): ...\n", "Gemfile": "gem 'sidekiq'\n"},
            "sidekiq",
        ),
        ({"package.json": json.dumps({"dependencies": {"bullmq": "5"}})}, "bullmq"),
        ({"package.json": json.dumps({"dependencies": {"bull": "4"}})}, "bull"),
    ],
    ids=["sidekiq", "bullmq", "bull"],
)
def test_other_job_systems(tmp_path: Path, files: dict[str, str], system: str) -> None:
    context, analysis = _context(tmp_path, files)

    context.detect_background_jobs()

    assert analysis["background_jobs"]["system"] == system


@pytest.mark.parametrize(
    "files",
    [
        {},
        {"package.json": "not json"},
        {"package.json": json.dumps({"dependencies": {"express": "4"}})},
        {"Gemfile": "gem 'rails'\n"},
    ],
    ids=["nothing", "unreadable package.json", "no queue", "no sidekiq"],
)
def test_no_job_system(tmp_path: Path, files: dict[str, str]) -> None:
    context, analysis = _context(tmp_path, files)

    context.detect_background_jobs()

    assert "background_jobs" not in analysis


# --------------------------------------------------------------------------
# API docs, monitoring
# --------------------------------------------------------------------------


def test_fastapi_documents_itself(tmp_path: Path) -> None:
    context, analysis = _context(tmp_path, {}, {"framework": "FastAPI"})

    context.detect_api_documentation()

    assert analysis["api_documentation"]["docs_url"] == "/docs"


@pytest.mark.parametrize(
    ("deps", "expected"),
    [
        (
            {"swagger-jsdoc": "6", "@apollo/server": "4", "graphql": "16"},
            {
                "type": "openapi",
                "library": "swagger-jsdoc",
                "docs_url": "/api-docs",
                "graphql": {"playground_url": "/graphql", "library": "@apollo/server"},
            },
        ),
        (
            {"swagger-ui-express": "5", "apollo-server": "3"},
            {
                "type": "openapi",
                "library": "swagger-ui-express",
                "docs_url": "/api-docs",
                "graphql": {"playground_url": "/graphql", "library": "apollo-server"},
            },
        ),
        (
            {"graphql": "16"},
            {"graphql": {"playground_url": "/graphql", "library": "graphql"}},
        ),
    ],
    ids=["jsdoc and apollo 4", "swagger ui and apollo 3", "plain graphql"],
)
def test_node_api_docs_name_the_installed_library(
    tmp_path: Path, deps: dict, expected: dict
) -> None:
    # Regression: swagger-jsdoc alone was reported as swagger-ui-express,
    # and @apollo/server as plain graphql.
    context, analysis = _context(
        tmp_path, {"package.json": json.dumps({"devDependencies": deps})}
    )

    context.detect_api_documentation()

    assert analysis["api_documentation"] == expected


@pytest.mark.parametrize(
    "package", [None, "{broken", json.dumps({"dependencies": {"express": "4"}})]
)
def test_no_api_docs(tmp_path: Path, package: str | None) -> None:
    context, analysis = _context(
        tmp_path, {} if package is None else {"package.json": package}
    )

    context.detect_api_documentation()

    assert "api_documentation" not in analysis


def test_monitoring_from_routes_metrics_and_services(tmp_path: Path) -> None:
    analysis = {
        "api": {
            "routes": [{"path": "/healthz"}, {"path": "/api/ping"}, {"path": "/users"}]
        },
        "services": {"monitoring": [{"type": "sentry", "client": "sentry-sdk"}]},
    }
    context, analysis = _context(
        tmp_path,
        {
            "analyzers/probe.py": "import prometheus_client\n",
            "src/metrics.js": "router.get('/metrics', h)\n",
        },
        analysis,
    )
    (tmp_path / "bad.py").write_bytes(b"\xff\xfe")

    context.detect_monitoring()

    assert analysis["monitoring"] == {
        "health_checks": ["/healthz", "/api/ping"],
        "metrics_endpoint": "/metrics",
        "metrics_type": "prometheus",
        "apm_tools": ["sentry"],
    }


def test_no_monitoring(tmp_path: Path) -> None:
    context, analysis = _context(
        tmp_path,
        {"analyzer.py": "from prometheus_client import Counter\n"},
        {"api": {"routes": [{"path": "/users"}]}, "services": {"databases": []}},
    )

    context.detect_monitoring()

    assert "monitoring" not in analysis


# --------------------------------------------------------------------------
# Ports outside the entry point
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("files", "port"),
    [
        ({"config/settings.py": "PORT = 80\nport = 8443\n"}, None),
        ({"settings.json": '{"port": 7001}'}, 7001),
        (
            {
                "package.json": json.dumps(
                    {"scripts": {"x": 1, "dev": "next dev -p 3001"}}
                )
            },
            3001,
        ),
        ({"package.json": json.dumps({"scripts": {"dev": "vite --port 80"}})}, None),
        ({"Makefile": "run:\n\tPORT=9090 ./serve\n"}, 9090),
        ({"start.sh": "serve -p 22\n"}, None),
        ({".env": "PORT=80\n", "run.sh": "serve --port 7777\n"}, 7777),
    ],
    ids=[
        "config below range",
        "settings.json",
        "package script",
        "package script below range",
        "Makefile",
        "script below range",
        "env below range, then script",
    ],
)
def test_ports_from_config_scripts_and_env(
    tmp_path: Path, files: dict[str, str], port: int | None
) -> None:
    detector = PortDetector(_write(tmp_path, files), {"language": "TypeScript"})

    # Below 1000 is not taken for a service port: the default stands.
    assert detector.detect_port_from_sources(5000) == (port or 5000)
