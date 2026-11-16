"""Project index (analysis/analyzers/): each stack written as a small real
project on disk, then analysed the way the spec pipeline and the project index
runner do (``analyze_project`` / ``analyzer.py``)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from analysis.analyzers import analyze_project, analyze_service
from analysis.analyzers.database_detector import DatabaseDetector
from analysis.analyzers.framework_analyzer import FrameworkAnalyzer
from analysis.analyzers.port_detector import PortDetector
from analysis.analyzers.project_analyzer_module import ProjectAnalyzer
from analysis.analyzers.route_detector import RouteDetector
from analysis.analyzers.service_analyzer import ServiceAnalyzer

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
# Windows runners do not default to UTF-8 in a child process.
_UTF8_ENV = {**os.environ, "PYTHONUTF8": "1"}


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


def _framework(root: Path, files: dict[str, str]) -> dict:
    analysis: dict = {}
    FrameworkAnalyzer(_write(root, files), analysis).detect_language_and_framework()
    return analysis


# --------------------------------------------------------------------------
# Languages and frameworks
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        (
            {
                "requirements.txt": "fastapi\ncelery\nsqlalchemy\n",
                "main.py": "uvicorn.run(app, port=8050)\n",
            },
            {
                "language": "Python",
                "package_manager": "pip",
                "framework": "FastAPI",
                "type": "backend",
                "default_port": 8050,
                "task_queue": "Celery",
                "orm": "SQLAlchemy",
            },
        ),
        (
            {
                "pyproject.toml": "[tool.poetry]\ndeps = ['flask', 'dramatiq', 'tortoise-orm']\n"
            },
            {
                "language": "Python",
                "package_manager": "poetry",
                "framework": "Flask",
                "default_port": 5000,
                "task_queue": "Dramatiq",
                "orm": "Tortoise ORM",
            },
        ),
        (
            {"pyproject.toml": "[tool.uv]\ndeps = ['huey', 'prisma']\n"},
            {
                "language": "Python",
                "package_manager": "uv",
                "task_queue": "Huey",
                "orm": "Prisma",
            },
        ),
        (
            {"pyproject.toml": "[project]\nname = 'x'\n"},
            {"language": "Python", "package_manager": "pip"},
        ),
        (
            {"Pipfile": "[packages]\ndjango = '*'\ncelery = '*'\n"},
            {
                "language": "Python",
                "package_manager": "pipenv",
                "framework": "Django",
                "type": "backend",
                "task_queue": "Celery",
            },
        ),
        (
            {"requirements.txt": "celery\n"},
            {"language": "Python", "type": "worker", "task_queue": "Celery"},
        ),
        (
            {
                "go.mod": "module x\nrequire github.com/gin-gonic/gin v1\n",
                "main.go": 'r.Run(":9090")\n',
            },
            {
                "language": "Go",
                "package_manager": "go mod",
                "framework": "Gin",
                "type": "backend",
                "default_port": 9090,
            },
        ),
        (
            {"go.mod": "module x\n"},
            {"language": "Go", "package_manager": "go mod"},
        ),
        (
            {"Cargo.toml": '[dependencies]\naxum = "0.7"\n'},
            {
                "language": "Rust",
                "package_manager": "cargo",
                "framework": "Axum",
                "default_port": 3000,
            },
        ),
        (
            {"Gemfile": "gem 'rails'\ngem 'sidekiq'\n"},
            {
                "language": "Ruby",
                "package_manager": "bundler",
                "framework": "Ruby on Rails",
                "default_port": 3000,
                "task_queue": "Sidekiq",
            },
        ),
        (
            {"Gemfile": "gem 'sinatra'\n"},
            {"language": "Ruby", "framework": "Sinatra", "default_port": 4567},
        ),
    ],
)
def test_backend_stacks(tmp_path: Path, files: dict[str, str], expected: dict) -> None:
    analysis = _framework(tmp_path, files)

    assert {k: analysis.get(k) for k in expected} == expected


def _node(root: Path, deps: dict, scripts: dict | None = None, lock: str = "") -> dict:
    files = {
        "package.json": json.dumps({"dependencies": deps, "scripts": scripts or {}})
    }
    if lock:
        files[lock] = ""
    return _framework(root, files)


@pytest.mark.parametrize(
    ("deps", "framework", "port"),
    [
        ({"next": "1", "react": "1"}, "Next.js", 3000),
        # Regression: "svelte" (and "react") came first, so a SvelteKit app
        # was "Svelte" and an Astro site with React islands "React".
        ({"svelte": "1", "@sveltejs/kit": "1"}, "SvelteKit", 5173),
        ({"astro": "1", "react": "1"}, "Astro", 4321),
        ({"@angular/core": "1"}, "Angular", 4200),
        ({"express": "1"}, "Express", 3000),
        ({"@nestjs/core": "1"}, "NestJS", 3000),
    ],
)
def test_node_frameworks(tmp_path: Path, deps: dict, framework: str, port: int) -> None:
    analysis = _node(tmp_path, deps)

    assert (analysis["framework"], analysis["default_port"]) == (framework, port)
    assert analysis["language"] == "JavaScript"


def test_node_tooling_and_package_managers(tmp_path: Path) -> None:
    first = _node(
        tmp_path / "a",
        {
            "typescript": "5",
            "vite": "5",
            "tailwindcss": "3",
            "zustand": "4",
            "bullmq": "1",
            "@prisma/client": "5",
        },
        {"dev": "vite --port 4100"},
        "pnpm-lock.yaml",
    )
    assert first["language"] == "TypeScript"
    assert first["package_manager"] == "pnpm"
    assert first["build_tool"] == "Vite"
    assert first["default_port"] == 4100
    assert first["styling"] == "Tailwind CSS"
    assert first["state_management"] == "Zustand"
    assert (first["task_queue"], first["type"]) == ("BullMQ", "worker")
    assert first["orm"] == "Prisma"
    assert first["dev_command"] == "npm run dev"

    rows = [
        (
            {"webpack": "1", "styled-components": "1", "redux": "1", "typeorm": "1"},
            "yarn.lock",
            ("Webpack", "styled-components", "Redux", "TypeORM", "yarn"),
        ),
        (
            {"esbuild": "1", "@emotion/react": "1", "jotai": "1", "drizzle-orm": "1"},
            "bun.lock",
            ("esbuild", "Emotion", "Jotai", "Drizzle", "bun"),
        ),
        (
            {"turbopack": "1", "pinia": "1", "mongoose": "1"},
            "",
            ("Turbopack", None, "Pinia", "Mongoose", "npm"),
        ),
    ]
    for n, (deps, lock, (build, style, state, orm, manager)) in enumerate(rows):
        a = _node(tmp_path / f"r{n}", deps, {"start": "node ."}, lock)
        assert (
            a.get("build_tool"),
            a.get("styling"),
            a.get("state_management"),
            a.get("orm"),
            a["package_manager"],
        ) == (build, style, state, orm, manager)
        assert a["dev_command"] == "npm run start"


def test_broken_package_json_is_no_language(tmp_path: Path) -> None:
    assert _framework(tmp_path, {"package.json": "{"}) == {}


def test_swift_projects(tmp_path: Path) -> None:
    app = _framework(
        tmp_path / "ios",
        {
            "Package.swift": '.package(url: "https://github.com/pointfreeco/swift-composable-architecture.git", from: "1.0")\n',
            "Sources/App.swift": "import SwiftUI\nimport Combine\nimport MapKit\n",
            ".build/Vendored.swift": "import UIKit\n",
        },
    )
    assert app["language"] == "Swift"
    assert app["package_manager"] == "Swift Package Manager"
    assert (app["framework"], app["type"]) == ("SwiftUI", "mobile")
    assert app["apple_frameworks"] == ["Combine", "MapKit"]
    assert app["spm_dependencies"] == ["swift-composable-architecture"]

    xcode = tmp_path / "mac"
    (xcode / "Mac.xcodeproj").mkdir(parents=True)
    xcode_app = _framework(
        xcode,
        {
            "Mac.xcodeproj/project.pbxproj": 'repositoryURL = "https://github.com/sparkle-project/Sparkle";\n',
            "Main.swift": "import AppKit\n",
        },
    )
    assert xcode_app["package_manager"] == "Xcode"
    assert (xcode_app["framework"], xcode_app["type"]) == ("AppKit", "desktop")
    assert xcode_app["spm_dependencies"] == ["Sparkle"]

    uikit = _framework(
        tmp_path / "uikit", {"Package.swift": "", "A.swift": "import UIKit\n"}
    )
    assert uikit["framework"] == "UIKit"


# --------------------------------------------------------------------------
# Ports
# --------------------------------------------------------------------------


def _port(root: Path, files: dict[str, str], language: str = "Python") -> int:
    return PortDetector(
        _write(root, files), {"language": language}
    ).detect_port_from_sources(1234)


def test_port_sources_in_order(tmp_path: Path) -> None:
    assert (
        _port(tmp_path / "a", {"server.js": "app.listen(80)\nconst PORT = 4001\n"})
        == 4001
    )
    assert _port(tmp_path / "b", {".env": "API_PORT=7001\n"}) == 7001
    assert _port(tmp_path / "c", {"config.json": '{"port": 6100}'}) == 6100
    assert _port(tmp_path / "d", {"Makefile": "run:\n\tPORT=5050 ./app\n"}) == 5050
    assert (
        _port(
            tmp_path / "e",
            {"package.json": json.dumps({"scripts": {"dev": "next dev -p 3005"}})},
            "TypeScript",
        )
        == 3005
    )
    # Out of range values are skipped, and nothing found keeps the default.
    assert (
        _port(tmp_path / "f", {".env": "PORT=80\n", "config.py": "PORT = 99\n"}) == 1234
    )
    assert (
        _port(
            tmp_path / "g", {"package.json": "{", "start.sh": "--port 22"}, "JavaScript"
        )
        == 1234
    )


def test_compose_port_after_other_keys_of_the_service(tmp_path: Path) -> None:
    # Regression: any "key:" line closed the service, so ports listed after
    # "image:" or "build:" (the usual order) were never read.
    root = tmp_path / "api"
    compose = (
        "services:\n"
        "  web:\n"
        "    ports:\n"
        '      - "8000:80"\n'
        "  api:\n"
        "    build: .\n"
        "    image: acme/api\n"
        "    # published port\n"
        "    ports:\n"
        '      - "9100:9000"\n'
        "    environment:\n"
        "      - PORT=9000\n"
    )
    assert _port(root, {"docker-compose.yml": compose}) == 9100

    nothing = tmp_path / "worker"
    assert _port(nothing, {"docker-compose.yml": compose}) == 1234
    four = tmp_path / "svc"
    assert (
        _port(
            four,
            {
                "docker-compose.yaml": "services:\n    svc:\n        ports:\n            - 7300:73\n"
            },
        )
        == 7300
    )


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------


def _routes(
    root: Path, files: dict[str, str]
) -> list[tuple[str, tuple[str, ...], str, bool]]:
    found = RouteDetector(_write(root, files)).detect_all_routes()
    return sorted(
        (r["path"], tuple(r["methods"]), r["framework"], r["requires_auth"])
        for r in found
    )


def test_python_routes(tmp_path: Path) -> None:
    routes = _routes(
        tmp_path,
        {
            "api/main.py": (
                '@app.get("/items")\n'
                '@router.post("/items", dependencies=[Depends(user)])\n'
                '@app.api_route("/mixed", methods=["GET", "PUT"])\n'
            ),
            "web/views.py": (
                "@login_required\n@app.route('/admin', methods=['POST'])\n"
                "@bp.route('/public')\n"
            ),
            "site/urls.py": "path('users/<int:id>/', v)\nre_path(r'^/old/$', v)\n",
            ".venv/lib/x.py": '@app.get("/vendored")\n',
            "bin.py": "",
        },
    )
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")

    assert routes == [
        ("/^/old/$", ("GET", "POST"), "Django", False),
        ("/admin", ("POST",), "Flask", True),
        ("/items", ("GET",), "FastAPI", False),
        ("/items", ("POST",), "FastAPI", True),
        ("/mixed", ("GET", "PUT"), "FastAPI", False),
        ("/public", ("GET",), "Flask", False),
        ("/users/<int:id>/", ("GET", "POST"), "Django", False),
    ]
    assert RouteDetector(tmp_path).detect_all_routes()[0]["file"].count("\\") == 0


def test_nextjs_routes_are_found(tmp_path: Path) -> None:
    # Regression: glob("**/route.{ts,js}") has no alternation in pathlib,
    # so no App Router or Pages Router route was ever listed.
    routes = _routes(
        tmp_path,
        {
            "app/route.ts": "export async function GET() {}\n",
            "app/(shop)/api/users/[id]/route.ts": (
                "export async function GET(r) { await auth() }\nexport function DELETE() {}\n"
            ),
            "app/api/static/route.js": "const x = 1\n",
            "pages/api/users/index.ts": "export default h\n",
            "pages/api/posts/[slug].js": "export default h\n",
            "pages/api/_middleware.ts": "",
        },
    )

    nextjs = [r for r in routes if r[2] == "Next.js"]
    assert nextjs == [
        ("/", ("GET",), "Next.js", False),
        ("/api/posts/:slug", ("GET", "POST"), "Next.js", False),
        ("/api/users", ("GET", "POST"), "Next.js", False),
        ("/api/users/:id", ("GET", "DELETE"), "Next.js", True),
    ]


def test_routes_of_other_stacks(tmp_path: Path) -> None:
    routes = _routes(
        tmp_path,
        {
            "server.js": "router.get('/me', authenticate, h)\napp.use('/api', r)\napp.post('/open', h)\n",
            "main.go": 'r.GET("/ping", h)\ne.Post("/items", h)\n',
            "src/main.rs": '.route("/health", get(h))\nweb::post().to(h)\n',
            "Controllers/OrdersController.cs": (
                '[Authorize]\n[Route("api/[controller]")]\npublic class OrdersController {\n'
                "    /// <summary>\n    /// Lists orders.\n    /// </summary>\n"
                '    [HttpGet]\n    public X List() {}\n    [AllowAnonymous]\n    [HttpPost("{id}")]\n'
                "}\n"
            ),
            "Plain/ThingController.cs": "class ThingController {\n [HttpDelete]\n}\n",
            "NotAController.cs": "class Helper {}\n",
            "src/UserController.java": (
                '@RestController\n@RequestMapping("users")\nclass UserController {\n'
                '  @PreAuthorize("x")\n  @GetMapping("/{id}")\n  User get() {\n    return u;\n  }\n'
                "  @PostMapping\n  User create() { return u; }\n"
                '  @RolesAllowed({"ADMIN"})\n'
                '  @RequestMapping(method = RequestMethod.PUT, value = "/bulk")\n  void bulk();\n}\n'
            ),
            "src/Admin.java": (
                '@Secured("ROLE_ADMIN")\n@RestController\n@RequestMapping("/admin")\n'
                "public class Admin {\n  @GetMapping\n  String home() { return x; }\n}\n"
            ),
            "src/Root.kt": '@Controller\nclass Root { @DeleteMapping("gone") }\n',
            "src/Plain.java": "class Plain {}\n",
            "config/routes.rb": "get 'about', to: 'pages#about'\nresources :posts\n",
        },
    )

    by_framework: dict[str, list] = {}
    for path, methods, framework, auth in routes:
        by_framework.setdefault(framework, []).append((path, methods, auth))
    assert by_framework["Express"] == [
        ("/me", ("GET",), True),
        ("/open", ("POST",), False),
    ]
    assert by_framework["Go"] == [
        ("/items", ("POST",), False),
        ("/ping", ("GET",), False),
    ]
    assert by_framework["Rust"] == [
        ("/", ("POST",), False),
        ("/health", ("GET",), False),
    ]
    assert by_framework["ASP.NET Core"] == [
        ("/api/orders", ("GET",), True),
        ("/api/orders/{id}", ("POST",), False),
        ("/things", ("DELETE",), False),
    ]
    # Regression: a 300-character look-back gave POST the @PreAuthorize of
    # the GET above it. A class-level guard covers every method.
    assert by_framework["Spring Boot"] == [
        ("/admin", ("GET",), True),
        ("/gone", ("DELETE",), False),
        ("/users", ("POST",), False),
        ("/users/bulk", ("PUT",), True),
        ("/users/{id}", ("GET",), True),
    ]
    assert ("/about", ("GET",), False) in by_framework["Rails"]
    assert len(by_framework["Rails"]) == 6
    summary = next(
        r["summary"]
        for r in RouteDetector(tmp_path).detect_all_routes()
        if r["framework"] == "ASP.NET Core" and r["methods"] == ["GET"]
    )
    assert summary == "Lists orders."


def test_unreadable_files_are_skipped_by_every_route_reader(tmp_path: Path) -> None:
    for name in (
        "a.py",
        "urls.py",
        "a.js",
        "a.go",
        "a.rs",
        "A.java",
        "config/routes.rb",
    ):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\xff\xfe\xfa")

    assert RouteDetector(tmp_path).detect_all_routes() == []


def test_a_file_outside_the_project_keeps_its_own_parts(tmp_path: Path) -> None:
    detector = RouteDetector(tmp_path / "project")
    assert detector._should_include_file(tmp_path / "elsewhere" / "a.py") is True
    assert (
        detector._should_include_file(tmp_path / "x" / "node_modules" / "a.py") is False
    )


# --------------------------------------------------------------------------
# Database models
# --------------------------------------------------------------------------


def test_sqlalchemy_models_keep_their_own_table_and_columns(tmp_path: Path) -> None:
    # Regression: __tablename__ was searched in the whole file and columns in
    # a fixed window, so the second model took the first one's table and both
    # got each other's columns; "Column(String(50), unique=True)" lost its
    # options at the first ")".
    _write(
        tmp_path,
        {
            "app/models.py": (
                "class User(Base):\n"
                "    __tablename__ = 'accounts'\n"
                "    id = Column(Integer, primary_key=True)\n"
                "    email = Column(String(50), unique=True, nullable=False)\n"
                "class Order(Base):\n"
                "    total = Column(Float)\n"
                "class Empty(Base):\n"
                "    pass\n"
            ),
            ".venv/lib/sqlalchemy/orm.py": "class Vendored(Base):\n    x = Column(Integer)\n",
        },
    )

    models = DatabaseDetector(tmp_path).detect_all_models()

    assert set(models) == {"User", "Order"}
    assert models["User"]["table"] == "accounts"
    assert models["User"]["file"] == "app/models.py"
    assert models["User"]["fields"] == {
        "id": {
            "type": "Integer",
            "primary_key": True,
            "unique": False,
            "nullable": True,
        },
        "email": {
            "type": "String",
            "primary_key": False,
            "unique": True,
            "nullable": False,
        },
    }
    assert models["Order"]["table"] == "orders"
    assert models["Order"]["fields"] == {
        "total": {
            "type": "Float",
            "primary_key": False,
            "unique": False,
            "nullable": True,
        }
    }


def test_django_typeorm_prisma_drizzle_and_mongoose(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            "shop/models.py": (
                "class Product(models.Model):\n"
                "    sku = models.CharField(max_length=20, unique=True)\n"
                "class Tag(models.Model):\n"
                "    label = models.TextField(null=True)\n"
            ),
            "src/user.entity.ts": (
                "@Entity()\nexport class User {\n  @PrimaryGeneratedColumn() id: number\n"
                "  @Column({ unique: true }) email: string\n}\n"
                "@Entity('posts')\nclass Post {\n  @Column() title: string\n}\n"
            ),
            "prisma/schema.prisma": (
                "model Account {\n  id Int @id @default(autoincrement())\n"
                "  email String @unique\n  bio String?\n  tags Tag[]\n  @@index([email])\n}\n"
            ),
            "db/schema.ts": "export const users = pgTable('users', {})\n",
            "models/cat.js": "module.exports = mongoose.model('Cat', s)\n",
        },
    )

    models = DatabaseDetector(tmp_path).detect_all_models()

    assert models["Product"]["fields"]["sku"] == {
        "type": "CharField",
        "unique": True,
        "nullable": False,
    }
    assert models["Tag"]["fields"] == {
        "label": {"type": "TextField", "unique": False, "nullable": True}
    }
    assert set(models["User"]["fields"]) == {"id", "email"}
    assert models["User"]["fields"]["email"]["unique"] is True
    assert set(models["Post"]["fields"]) == {"title"}
    # Regression: "\w+" left "?" out of the type, so nothing was nullable.
    assert models["Account"]["fields"] == {
        "id": {"type": "Int", "primary_key": True, "unique": False, "nullable": False},
        "email": {
            "type": "String",
            "primary_key": False,
            "unique": True,
            "nullable": False,
        },
        "bio": {
            "type": "String",
            "primary_key": False,
            "unique": False,
            "nullable": True,
        },
        "tags": {
            "type": "Tag[]",
            "primary_key": False,
            "unique": False,
            "nullable": False,
        },
    }
    assert models["users"] == {
        "table": "users",
        "fields": {},
        "file": "db/schema.ts",
        "orm": "Drizzle",
    }
    assert models["Cat"]["orm"] == "Mongoose"


def test_unreadable_model_files_are_skipped(tmp_path: Path) -> None:
    for name in (
        "a.py",
        "models.py",
        "prisma/schema.prisma",
        "a.entity.ts",
        "schema.ts",
        "models/a.js",
    ):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\xff\xfe\xfa")

    assert DatabaseDetector(tmp_path).detect_all_models() == {}


# --------------------------------------------------------------------------
# Services and projects
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "files", "kind"),
    [
        ("web-client", {}, "frontend"),
        ("orders-api", {}, "backend"),
        ("mailer-queue", {}, "worker"),
        ("spider", {}, "scraper"),
        ("edge-gateway", {}, "proxy"),
        ("shared", {}, "library"),
        ("tool", {"requirements.txt": "click\n", "run.py": ""}, "backend"),
        ("tool", {"requirements.txt": "click\n"}, "unknown"),
        ("misc", {}, "unknown"),
    ],
)
def test_service_type_from_name_or_content(
    tmp_path: Path, name: str, files: dict[str, str], kind: str
) -> None:
    root = _write(tmp_path / name, files)
    root.mkdir(exist_ok=True)

    assert ServiceAnalyzer(root, name).analyze()["type"] == kind


def test_python_service_analysis(tmp_path: Path) -> None:
    root = _write(
        tmp_path / "svc",
        {
            "requirements.txt": "# deps\n-r base.txt\nFastAPI==1\nPyJWT\nSQLAlchemy\nRedis\n",
            "pytest.ini": "",
            "main.py": '@app.get("/health")\ndef h(): pass\nimport os\nos.getenv("FEATURE_FLAG")\n',
            "app/models.py": "class Thing(Base):\n    id = Column(Integer, primary_key=True)\n",
            "tests/test_a.py": "",
            "Dockerfile": "",
            ".env": (
                "export DEBUG=true\nDATABASE_URL=postgres://app:s3cret@db/app\n"
                "PUBLIC_URL=https://example.org\nAPI_TOKEN=abc\n"
            ),
            "metrics.py": "from prometheus_client import Counter\n",
            "auth.py": "@require_admin\ndef x(): pass\n",
        },
    )

    a = ServiceAnalyzer(root, "svc").analyze()

    assert a["framework"] == "FastAPI"
    assert a["entry_point"] == "main.py"
    assert a["dependencies"] == ["FastAPI", "PyJWT", "SQLAlchemy", "Redis"]
    assert a["testing"] == "pytest" and a["test_directory"] == "tests"
    assert a["dockerfile"] == "Dockerfile"
    assert a["key_directories"]["app"]["path"] == "app"
    assert a["api"]["methods"] == ["GET"]
    assert a["database"]["model_names"] == ["Thing"]
    assert a["monitoring"] == {
        "health_checks": ["/health"],
        "metrics_endpoint": "/metrics",
        "metrics_type": "prometheus",
    }
    variables = a["environment"]["variables"]
    assert variables["DEBUG"]["type"] == "boolean"
    # A connection URL with a password in it is a secret too.
    assert variables["DATABASE_URL"] == {
        "value": "<REDACTED>",
        "source": ".env",
        "type": "url",
        "sensitive": True,
        "required": False,
    }
    assert variables["PUBLIC_URL"]["value"] == "https://example.org"
    assert variables["API_TOKEN"]["value"] == "<REDACTED>"
    assert variables["FEATURE_FLAG"]["source"] == "code:main.py"
    # Regression: requirements were compared as written, so "PyJWT" and
    # "SQLAlchemy" never matched "pyjwt" / "sqlalchemy".
    assert a["auth"]["strategies"] == ["jwt"]
    assert a["auth"]["middleware"] == ["require_admin"]
    assert {"type": "postgresql", "client": "sqlalchemy"} not in a["services"].get(
        "databases", []
    )
    assert {"type": "redis"} in a["services"]["cache"]
    assert a["api_documentation"]["docs_url"] == "/docs"


def test_vendored_files_do_not_shape_the_service(tmp_path: Path) -> None:
    # Regression: the globs walked into .venv, where the installed
    # prometheus_client and Django's own migrations were taken as the
    # project's.
    root = _write(
        tmp_path / "svc",
        {
            "manage.py": "",
            "requirements.txt": "django\n",
            ".venv/lib/prometheus_client/core.py": "import prometheus_client\n",
            ".venv/lib/django/contrib/auth/migrations/0001.py": "",
            "shop/migrations/0001_initial.py": "",
        },
    )

    a = ServiceAnalyzer(root, "svc").analyze()

    assert "monitoring" not in a
    assert a["migrations"]["directories"] == ["shop/migrations"]


def test_monorepo_index_with_compose_ci_and_conventions(tmp_path: Path) -> None:
    root = _write(
        tmp_path / "repo",
        {
            "pnpm-workspace.yaml": "",
            "apps/web/package.json": json.dumps(
                {
                    "dependencies": {
                        "next": "1",
                        "@acme/ui": "1",
                        "@webassemblyjs/ast": "1",
                    },
                    "devDependencies": {"vitest": "1", "@playwright/test": "1"},
                }
            ),
            "apps/api/requirements.txt": "flask\n",
            "packages/ui/package.json": json.dumps({"dependencies": {"react": "1"}}),
            "packages/empty/README.md": "",
            "docker-compose.yml": (
                "# stack\nservices:\n    web:\n        image: x\n    api:\n        build: .\n"
                "volumes:\n  data:\n"
            ),
            "docker/Dockerfile.api": "",
            ".github/workflows/ci.yml": "",
            ".github/workflows/release.yaml": "",
            "vercel.json": "{}",
            "ruff.toml": "",
            "pyproject.toml": "[tool.black]\n",
            ".eslintrc.json": "{}",
            ".prettierrc": "{}",
            "tsconfig.json": "{}",
            ".pre-commit-config.yaml": "",
        },
    )

    index = analyze_project(root, tmp_path / "out" / "index.json")

    assert index["project_type"] == "monorepo"
    assert index["monorepo_tool"] == "pnpm-workspace"
    assert set(index["services"]) == {"web", "api", "ui"}
    web = index["services"]["web"]
    assert web["testing"] == "Vitest" and web["e2e_testing"] == "Playwright"
    # Regression: "@web" matched "@webassemblyjs/ast"; "@acme/ui" names the
    # workspace package "ui".
    assert web["consumes"] == ["api.api", "ui"]
    infra = index["infrastructure"]
    # Regression: a four-space compose file listed no service.
    assert infra["docker_services"] == ["web", "api"]
    assert infra["dockerfiles"] == ["docker/Dockerfile.api"]
    assert infra["ci_workflows"] == ["ci.yml", "release.yaml"]
    assert infra["deployment"] == "Vercel"
    assert index["conventions"] == {
        "python_linting": "Ruff",
        "python_formatting": "Black",
        "js_linting": "ESLint",
        "formatting": "Prettier",
        "typescript": True,
        "git_hooks": "pre-commit",
    }
    saved = json.loads((tmp_path / "out" / "index.json").read_text(encoding="utf-8"))
    assert saved["services"].keys() == index["services"].keys()


@pytest.mark.parametrize(
    ("files", "kind", "extra"),
    [
        (
            {"backend/requirements.txt": "flask\n", "frontend/package.json": "{}"},
            "monorepo",
            {},
        ),
        ({"lerna.json": "{}"}, "monorepo", {"monorepo_tool": "lerna"}),
        (
            {
                "requirements.txt": "flask\n",
                ".gitlab-ci.yml": "",
                "fly.toml": "",
                "docker-compose.yaml": "services:\n  a:\n",
                "Dockerfile": "",
                ".flake8": "",
                ".husky/pre-commit": "",
            },
            "single",
            {},
        ),
    ],
)
def test_project_shapes(
    tmp_path: Path, files: dict[str, str], kind: str, extra: dict
) -> None:
    index = ProjectAnalyzer(_write(tmp_path, files)).analyze()

    assert index["project_type"] == kind
    for key, value in extra.items():
        assert index[key] == value


def test_single_project_infrastructure(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            "requirements.txt": "flask\n",
            ".gitlab-ci.yml": "",
            "fly.toml": "",
            "docker-compose.yaml": "services:\n  a:\n",
            "Dockerfile": "",
            ".flake8": "",
            ".husky/pre-commit": "",
        },
    )

    index = ProjectAnalyzer(tmp_path).analyze()

    assert set(index["services"]) == {"main"}
    assert index["infrastructure"] == {
        "docker_compose": "docker-compose.yaml",
        "docker_services": ["a"],
        "dockerfile": "Dockerfile",
        "ci": "GitLab CI",
        "deployment": "Fly.io",
    }
    assert index["conventions"] == {"python_linting": "Flake8", "git_hooks": "Husky"}


def test_circleci_and_pylint(tmp_path: Path) -> None:
    _write(tmp_path, {".circleci/config.yml": "", "pylintrc": ""})

    index = ProjectAnalyzer(tmp_path).analyze()

    assert index["infrastructure"]["ci"] == "CircleCI"
    assert index["conventions"]["python_linting"] == "Pylint"


def test_analyze_service_finds_it_in_the_usual_folders(tmp_path: Path) -> None:
    _write(tmp_path, {"services/billing/go.mod": "module b\n"})

    out = tmp_path / "o" / "billing.json"
    result = analyze_service(tmp_path, "billing", out)

    assert result["language"] == "Go"
    assert json.loads(out.read_text(encoding="utf-8"))["name"] == "billing"
    with pytest.raises(ValueError, match="Service 'nope' not found"):
        analyze_service(tmp_path, "nope")


def test_analyzer_command_line(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {"svc/Cargo.toml": '[dependencies]\nrocket = "0.5"\n', "Cargo.toml": ""},
    )
    out = tmp_path / "index.json"

    project = subprocess.run(
        [
            sys.executable,
            "analyzer.py",
            "--project-dir",
            str(tmp_path),
            "--output",
            str(out),
            "--quiet",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        env=_UTF8_ENV,
    )
    service = subprocess.run(
        [
            sys.executable,
            "analyzer.py",
            "--project-dir",
            str(tmp_path),
            "--service",
            "svc",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        env=_UTF8_ENV,
    )

    # Regression: --quiet promised only JSON, yet the library printed
    # "Project index saved to: ..." on every call.
    assert project.stdout == ""
    loud = subprocess.run(
        [
            sys.executable,
            "analyzer.py",
            "--project-dir",
            str(tmp_path),
            "--output",
            str(out),
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        env=_UTF8_ENV,
    )
    assert loud.stdout.startswith(f"Saved to: {out.as_posix()}\n{{")
    assert (
        json.loads(out.read_text(encoding="utf-8"))["services"]["main"]["language"]
        == "Rust"
    )
    assert json.loads(service.stdout)["framework"] == "Rocket"
