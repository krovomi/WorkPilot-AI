"""The Environment Cloner (``--env-capture``, ``--env-reproduce``, ``--env-validate``).

A compose file on disk is captured, written back as a clone and validated.
Docker itself is replaced by a scripted stand-in for ``subprocess.run`` that
checks the command it is given; the ports the validator probes are real
sockets on 127.0.0.1.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import environment.capturer as capturer_module
import environment.validator as validator_module
import pytest
from environment import (
    ComposeGenerator,
    EnvironmentCapture,
    EnvironmentCapturer,
    EnvironmentValidator,
    ServiceCapture,
    ValidationResult,
)

COMPOSE = """\
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: hunter2
      EMPTY:
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready"]
      interval: 5s
      timeout: 3s
      retries: 5
  api:
    image: registry.local:5000/shop/api
    command: ["uvicorn", "main:app"]
    ports:
      - "127.0.0.1:8000:80"
      - "9000:9000/tcp"
      - target: 443
        published: 8443
      - "3000"
      - "x:y"
    environment:
      - DEBUG=1
      - API_KEY=abc
      - NOVALUE
    depends_on:
      db:
        condition: service_healthy
  worker:
    image: python
    command: celery worker
    depends_on: [db]
  broken: just-a-string
networks:
  backend:
volumes:
  pgdata:
"""


class FakeDocker:
    """Answers the docker commands the cloner runs, from a script."""

    def __init__(self, answers: dict[tuple[str, ...], subprocess.CompletedProcess]):
        self.answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(list(cmd))
        assert kwargs.get("shell") is not True
        for prefix, answer in self.answers.items():
            if tuple(cmd[: len(prefix)]) == prefix:
                if isinstance(answer, BaseException):
                    raise answer
                return answer
        raise FileNotFoundError(cmd[0])


def _done(stdout: str = "", code: int = 0, stderr: str = ""):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "docker-compose.yml").write_text(COMPOSE, encoding="utf-8")
    (root / ".env").write_text(
        "# comment\n\nDATABASE_URL='postgres://db/app'\nSECRET_TOKEN=s3cr3t\n"
        "NOT A PAIR\n",
        encoding="utf-8",
    )
    (root / ".env.example").write_text('PORT="8000"\n', encoding="utf-8")
    return root


# ── Capture ──────────────────────────────────────────────────────────


class TestCaptureFromCompose:
    def test_services_ports_secrets_and_dependencies(self, project):
        capture = EnvironmentCapturer(project).capture_from_compose()

        assert capture.project_name == "shop"
        assert capture.source == "compose_file"
        assert [s.name for s in capture.services] == ["db", "api", "worker"]
        db, api, worker = capture.services
        assert (db.image, db.tag) == ("postgres", "16")
        assert db.ports == [{"host": 5432, "container": 5432}]
        assert db.environment == {
            "POSTGRES_USER": "app",
            "POSTGRES_PASSWORD": "<REPLACE_ME>",
            "EMPTY": "",
        }
        assert db.health_check == {
            "test": ["CMD", "pg_isready"],
            "interval": "5s",
            "timeout": "3s",
            "retries": 5,
        }
        assert db.volumes == ["pgdata:/var/lib/postgresql/data"]
        assert (api.image, api.tag) == ("registry.local:5000/shop/api", "latest")
        assert api.ports == [
            {"host": 8000, "container": 80},
            {"host": 9000, "container": 9000},
            {"host": 8443, "container": 443},
        ]
        assert api.environment == {"DEBUG": "1", "API_KEY": "<REPLACE_ME>"}
        assert api.command == "uvicorn main:app"
        assert api.depends_on == ["db"]
        assert (worker.command, worker.depends_on, worker.tag) == (
            "celery worker",
            ["db"],
            "latest",
        )
        assert capture.networks == ["backend"]
        assert capture.volumes == ["pgdata"]
        assert capture.env_vars == {
            "DATABASE_URL": "postgres://db/app",
            "SECRET_TOKEN": "<REPLACE_ME>",
            "PORT": "8000",
        }

    def test_an_explicit_compose_file(self, project):
        other = project / "deploy" / "stack.yml"
        other.parent.mkdir()
        other.write_text("services:\n  web:\n    image: nginx:1.27\n", encoding="utf-8")

        capture = EnvironmentCapturer(project).capture_from_compose(other)

        assert [(s.name, s.image, s.tag) for s in capture.services] == [
            ("web", "nginx", "1.27")
        ]
        assert capture.networks == []

    def test_an_empty_compose_file(self, project):
        (project / "docker-compose.yml").write_text("", encoding="utf-8")

        assert EnvironmentCapturer(project).capture_from_compose().services == []

    def test_no_compose_file(self, tmp_path, caplog):
        capture = EnvironmentCapturer(tmp_path).capture_from_compose()

        assert capture.services == []
        assert capture.captured_at
        assert "No docker-compose file found" in caplog.text

    @pytest.mark.parametrize(
        "name",
        ["compose.yaml", "docker-compose.dev.yml"],
    )
    def test_other_compose_names_are_found(self, tmp_path, name):
        (tmp_path / name).write_text(
            "services:\n  a:\n    image: x\n", encoding="utf-8"
        )

        assert [
            s.name
            for s in EnvironmentCapturer(tmp_path).capture_from_compose().services
        ] == ["a"]

    def test_without_pyyaml_the_service_names_are_still_read(
        self, project, monkeypatch
    ):
        monkeypatch.setitem(sys.modules, "yaml", None)

        capture = EnvironmentCapturer(project).capture_from_compose()

        assert [s.name for s in capture.services] == ["db", "api", "worker", "broken"]

    def test_without_pyyaml_any_indentation_is_read(self, tmp_path, monkeypatch):
        monkeypatch.setitem(sys.modules, "yaml", None)
        (tmp_path / "docker-compose.yml").write_text(
            "version: '3'\n"
            "volumes:\n"
            "    data:\n"
            "services:\n"
            "    # the web tier\n"
            "    'web':\n"
            "        image: nginx\n"
            "\n"
            "    cache:\n"
            "        image: redis\n",
            encoding="utf-8",
        )

        capture = EnvironmentCapturer(tmp_path).capture_from_compose()

        assert [s.name for s in capture.services] == ["web", "cache"]

    def test_an_unreadable_env_file_is_skipped(self, project, monkeypatch):
        real = Path.read_text

        def locked(self, *a, **k):
            if self.name == ".env":
                raise PermissionError("locked")
            return real(self, *a, **k)

        monkeypatch.setattr(Path, "read_text", locked)

        assert EnvironmentCapturer(project).capture_env_files() == {"PORT": "8000"}

    def test_save_capture(self, project, tmp_path):
        capturer = EnvironmentCapturer(project)
        capture = capturer.capture_from_compose()

        saved = capturer.save_capture(capture, tmp_path / "out")

        assert saved.name == "environment_capture.json"
        assert json.loads(saved.read_text(encoding="utf-8")) == capture.to_dict()


class TestCaptureFromContainers:
    def _inspect(self, **config):
        return json.dumps(
            [
                {
                    "Config": {
                        "Image": "redis:7",
                        "Env": ["REDIS_PASSWORD=x", "TZ=UTC", "BAD"],
                        **config,
                    },
                    "HostConfig": {
                        "PortBindings": {
                            "6379/tcp": [{"HostPort": "6380"}],
                            "16379/tcp": [{"HostPort": ""}],
                            "26379/tcp": [],
                            "bad/tcp": [{"HostPort": "1"}],
                        }
                    },
                    "Mounts": [
                        {"Source": "/srv/redis", "Destination": "/data"},
                        {"Source": "", "Destination": "/tmp"},
                    ],
                }
            ]
        )

    def test_running_containers_are_inspected(self, project, monkeypatch):
        docker = FakeDocker(
            {
                ("docker", "ps"): _done(
                    "c1\tshop-cache\tredis:7\nc2\tother\tnginx\nshort\n"
                ),
                ("docker", "inspect", "c1"): _done(self._inspect()),
            }
        )
        monkeypatch.setattr(capturer_module.subprocess, "run", docker)

        capture = EnvironmentCapturer(project).capture_from_running_containers(
            prefix="shop-"
        )

        assert capture.source == "running_containers"
        (cache,) = capture.services
        assert (cache.name, cache.image, cache.tag) == ("shop-cache", "redis", "7")
        assert cache.environment == {"REDIS_PASSWORD": "<REPLACE_ME>", "TZ": "UTC"}
        assert cache.ports == [{"host": 6380, "container": 6379}]
        assert cache.volumes == ["/srv/redis:/data"]
        assert ["docker", "inspect", "other"] not in docker.calls

    @pytest.mark.parametrize(
        "inspect",
        [
            _done("", code=1),
            _done("[]"),
            _done("not json"),
        ],
    )
    def test_an_inspect_that_tells_nothing(self, project, monkeypatch, inspect):
        docker = FakeDocker(
            {
                ("docker", "ps"): _done("c1\tweb\tnginx\n"),
                ("docker", "inspect"): inspect,
            }
        )
        monkeypatch.setattr(capturer_module.subprocess, "run", docker)

        (web,) = EnvironmentCapturer(project).capture_from_running_containers().services

        assert (web.name, web.image, web.ports) == ("web", "nginx", [])

    def test_docker_ps_failing(self, project, monkeypatch, caplog):
        monkeypatch.setattr(
            capturer_module.subprocess,
            "run",
            FakeDocker({("docker", "ps"): _done(code=1, stderr="daemon down")}),
        )

        capture = EnvironmentCapturer(project).capture_from_running_containers()

        assert capture.services == []
        assert "daemon down" in caplog.text

    def test_without_docker(self, project, monkeypatch, caplog):
        monkeypatch.setattr(capturer_module.subprocess, "run", FakeDocker({}))

        capture = EnvironmentCapturer(project).capture_from_running_containers()

        assert capture.services == []
        assert capture.env_vars["PORT"] == "8000"
        assert "Docker not available" in caplog.text


# ── Generate ─────────────────────────────────────────────────────────


class TestGenerator:
    def test_compose_env_and_seed_round_trip(self, project, tmp_path):
        capture = EnvironmentCapturer(project).capture_from_compose()

        files = ComposeGenerator(capture).write_all(tmp_path / "clone")

        assert [f.name for f in files] == [
            "docker-compose.clone.yml",
            ".env.clone",
            "seed.sh",
        ]
        recaptured = EnvironmentCapturer(project).capture_from_compose(files[0])
        assert [s.name for s in recaptured.services] == ["db", "api", "worker"]
        assert recaptured.services[0].health_check["test"] == "CMD pg_isready"
        assert recaptured.services[1].ports == capture.services[1].ports
        assert recaptured.networks == ["backend"]
        assert recaptured.volumes == ["pgdata"]
        env = files[1].read_text(encoding="utf-8")
        assert "SECRET_TOKEN=<REPLACE_ME>" in env
        assert "# [db]\nEMPTY=" in env
        assert env.count("POSTGRES_USER=app") == 1
        seed = files[2].read_text(encoding="utf-8")
        assert "psql -U ${POSTGRES_USER:-postgres}" in seed

    def test_seed_commands_per_database(self):
        capture = EnvironmentCapture(
            project_name="p",
            services=[
                ServiceCapture(name="m", image="mysql", tag="8"),
                ServiceCapture(name="mdb", image="mariadb"),
                ServiceCapture(name="mg", image="mongo"),
                ServiceCapture(name="r", image="redis"),
            ],
        )

        seed = ComposeGenerator(capture).generate_seed_script()

        assert seed.count("mysql -u ${MYSQL_USER:-root}") == 2
        assert "mongosh --eval" in seed
        assert "docker exec r redis-cli PING" in seed

    def test_no_database_no_seed(self):
        seed = ComposeGenerator(
            EnvironmentCapture(project_name="p", services=[ServiceCapture("web")])
        ).generate_seed_script()

        assert 'echo "No databases to seed."' in seed

    def test_a_service_without_image_tag_or_test(self):
        compose = ComposeGenerator(
            EnvironmentCapture(
                project_name="p",
                services=[
                    ServiceCapture(
                        "web",
                        image="nginx",
                        tag="",
                        health_check={"retries": 0, "test": "curl -f localhost"},
                    ),
                    ServiceCapture("bare"),
                ],
            )
        ).generate()

        assert "    image: nginx\n" in compose
        assert "      test: curl -f localhost" in compose
        assert "retries" not in compose
        assert "  bare:\n\n" in compose

    def test_chmod_refused(self, tmp_path, monkeypatch):
        def refuse(self, mode):
            raise PermissionError("no chmod")

        monkeypatch.setattr(Path, "chmod", refuse)

        files = ComposeGenerator(EnvironmentCapture(project_name="p")).write_all(
            tmp_path
        )

        assert files[2].exists()


# ── Validate ─────────────────────────────────────────────────────────


@pytest.fixture
def listening_port():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen()
    try:
        yield server.getsockname()[1]
    finally:
        server.close()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _clone(project: Path, ports: dict[str, int], where: str = "") -> Path:
    capture = EnvironmentCapture(
        project_name="p",
        services=[
            ServiceCapture(name, image="img", ports=[{"host": p, "container": 80}])
            for name, p in ports.items()
        ],
    )
    target = project / where if where else project
    return ComposeGenerator(capture).write_all(target)[0]


class TestValidator:
    def test_everything_up(self, tmp_path, listening_port, monkeypatch):
        _clone(tmp_path, {"web": listening_port}, ".workpilot/environment")
        rows = [{"Service": "web", "State": "running"}]
        docker = FakeDocker(
            {
                ("docker", "compose", "version"): _done("v2"),
                ("docker", "compose", "-f"): _done(json.dumps(rows) + "\n"),
            }
        )
        monkeypatch.setattr(validator_module.subprocess, "run", docker)

        result = EnvironmentValidator(tmp_path).validate(timeout=5)

        assert result.to_dict() == {
            "success": True,
            "services_up": ["web"],
            "services_down": [],
            "port_checks": {f"web:{listening_port}": True},
            "errors": [],
        }
        assert docker.calls[1][-3:] == ["ps", "--format", "json"]

    def test_a_service_down_and_a_dead_port(self, tmp_path, monkeypatch):
        dead = _free_port()
        _clone(tmp_path, {"db": dead})
        lines = "\n".join(
            [
                json.dumps({"Service": "db", "State": "exited"}),
                json.dumps({"Name": "cache", "State": "running"}),
                "garbage",
            ]
        )
        monkeypatch.setattr(
            validator_module.subprocess,
            "run",
            FakeDocker(
                {
                    ("docker", "compose", "version"): _done("v2"),
                    ("docker", "compose", "-f"): _done(lines),
                }
            ),
        )
        monkeypatch.setattr(validator_module.time, "sleep", lambda _s: None)
        clock = iter([0.0, 0.0, 1.0, 99.0])
        monkeypatch.setattr(validator_module.time, "time", lambda: next(clock))

        result = EnvironmentValidator(tmp_path).validate(timeout=10)

        assert result.success is False
        assert result.services_up == ["cache"]
        assert result.services_down == ["db"]
        assert result.errors == [f"Ports not responding: db:{dead}"]

    def test_compose_v1_text_output(self, tmp_path, monkeypatch):
        _clone(tmp_path, {})
        table = (
            "Name   Command   State   Ports\n"
            "p_web_1   nginx   Up   80/tcp\n"
            "p_db_1   postgres   Exit 1\n"
            "x\n"
        )

        def compose(cmd, **_kw):
            if cmd[:2] == ["docker", "compose"]:
                raise FileNotFoundError("docker")
            if cmd == ["docker-compose", "version"]:
                return _done("1.29")
            if cmd[-1] == "json":
                return _done(code=1)
            return _done(table)

        monkeypatch.setattr(validator_module.subprocess, "run", compose)

        result = EnvironmentValidator(tmp_path).validate(timeout=1)

        assert result.services_up == ["p_web_1"]
        assert result.services_down == ["p_db_1"]

    def test_no_compose_file(self, tmp_path):
        result = EnvironmentValidator(tmp_path).validate()

        assert result.errors == ["Compose file not found: docker-compose.clone.yml"]

    @pytest.mark.parametrize(
        "answers",
        [
            {},  # no docker at all
            {
                ("docker", "compose", "version"): subprocess.TimeoutExpired("d", 5),
                ("docker-compose", "version"): _done(code=1),
            },
        ],
    )
    def test_no_compose_command(self, tmp_path, monkeypatch, answers):
        _clone(tmp_path, {})
        monkeypatch.setattr(validator_module.subprocess, "run", FakeDocker(answers))

        result = EnvironmentValidator(tmp_path).validate()

        assert result.errors == ["Failed to get docker-compose status"]

    def test_ps_failing_both_ways_or_hanging(self, tmp_path, monkeypatch):
        _clone(tmp_path, {})
        monkeypatch.setattr(
            validator_module.subprocess,
            "run",
            FakeDocker(
                {
                    ("docker", "compose", "version"): _done("v2"),
                    ("docker", "compose", "-f"): _done(code=1),
                }
            ),
        )
        assert EnvironmentValidator(tmp_path).validate().errors == [
            "Failed to get docker-compose status"
        ]

        monkeypatch.setattr(
            validator_module.subprocess,
            "run",
            FakeDocker(
                {
                    ("docker", "compose", "version"): _done("v2"),
                    ("docker", "compose", "-f"): subprocess.TimeoutExpired("d", 15),
                }
            ),
        )
        assert EnvironmentValidator(tmp_path).validate().errors == [
            "Failed to get docker-compose status"
        ]

    def test_unreadable_compose_ports_and_a_refused_socket(self, tmp_path, monkeypatch):
        validator = EnvironmentValidator(tmp_path)
        assert validator._get_exposed_ports(tmp_path / "missing.yml") == {}

        def no_socket(*_a, **_k):
            raise OSError("no network")

        monkeypatch.setattr(validator_module.socket, "socket", no_socket)
        assert validator._check_port(80) is False

    def test_validation_result_defaults(self):
        assert ValidationResult().to_dict()["success"] is False
