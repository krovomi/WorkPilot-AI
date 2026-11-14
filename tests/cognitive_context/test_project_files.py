"""The optimizer reads the project it is pointed at, and nothing else."""

from __future__ import annotations

from pathlib import Path

import pytest
from cognitive_context.api import router
from cognitive_context.optimizer import CognitiveContextOptimizer
from cognitive_context.project_files import (
    MAX_FILE_BYTES,
    discover_candidates,
    resolve_candidates,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from foundation.platform import is_windows


def _write(path: Path, content: str = "x = 1\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestResolveCandidates:
    def test_relative_and_absolute_paths_inside_are_kept(self, project: Path) -> None:
        _write(project / "src" / "Orders.cs", "public class Orders {}\n")
        _write(project / "main.go", "package main\n")
        accepted, refused = resolve_candidates(
            project, ["src/Orders.cs", str(project / "main.go"), "src/Orders.cs"]
        )
        assert accepted == ["src/Orders.cs", "main.go"]
        assert refused == []

    def test_a_file_outside_the_project_is_refused(
        self, project: Path, tmp_path: Path
    ) -> None:
        outside = _write(tmp_path / "elsewhere.txt", "not yours\n")
        accepted, refused = resolve_candidates(
            project, [str(outside), "../elsewhere.txt"]
        )
        assert accepted == []
        assert [r.reason for r in refused] == ["outside", "outside"]

    @pytest.mark.skipif(is_windows(), reason="symlinks need privileges on Windows")
    def test_a_symlink_leading_out_is_refused(
        self, project: Path, tmp_path: Path
    ) -> None:
        outside = _write(tmp_path / "elsewhere.txt", "not yours\n")
        (project / "link.txt").symlink_to(outside)
        accepted, refused = resolve_candidates(project, ["link.txt"])
        assert accepted == []
        assert refused[0].reason == "outside"

    def test_missing_binary_and_oversized_files_are_refused(
        self, project: Path
    ) -> None:
        (project / "logo.png").write_bytes(b"\x89PNG\x00\x00binary")
        (project / "dump.sql").write_text("x" * (MAX_FILE_BYTES + 1), encoding="utf-8")
        accepted, refused = resolve_candidates(
            project, ["absent.rs", "logo.png", "dump.sql"]
        )
        assert accepted == []
        assert [r.reason for r in refused] == ["missing", "binary", "too_large"]


class TestDiscoverCandidates:
    def test_every_stack_is_proposed_and_dependencies_skipped(
        self, project: Path
    ) -> None:
        sources = [
            "Api/Controllers/OrdersController.cs",
            "Api/Api.csproj",
            "service/orders.go",
            "crates/orders/src/lib.rs",
            "app/src/main/kotlin/Orders.kt",
            "src/main/java/Orders.java",
            "src/Controller/OrdersController.php",
            "Sources/Orders.swift",
            "lib/orders.dart",
            "web/src/Orders.vue",
            "Pages/Orders.razor",
        ]
        for rel in sources:
            _write(project / rel)
        for rel in [
            "node_modules/pkg/index.js",
            "Api/bin/Debug/Api.dll.config.json",
            "Api/obj/project.assets.json",
            "vendor/lib/x.php",
            "target/debug/build.rs",
            ".git/config.json",
        ]:
            _write(project / rel)
        found = discover_candidates(project, "orders")
        assert sorted(found) == sorted(sources)

    def test_paths_naming_the_prompt_come_first(self, project: Path) -> None:
        _write(project / "billing" / "Invoice.cs")
        _write(project / "orders" / "OrderService.cs")
        found = discover_candidates(project, "Fix the order service total")
        assert found[0] == "orders/OrderService.cs"


class TestSlicingEveryStack:
    @pytest.mark.parametrize(
        ("name", "source", "signature"),
        [
            (
                "Orders.cs",
                "using System;\nnamespace Shop;\npublic class Orders\n{\n"
                + "    var filler = 1;\n" * 400
                + "    public decimal Total(int id)\n    {\n        return 0;\n    }\n}\n",
                "public decimal Total(int id)",
            ),
            (
                "orders.go",
                'package orders\n\nimport "fmt"\n\n'
                + "// filler\n" * 400
                + "func Total(id int) int {\n\treturn 0\n}\n",
                "func Total(id int) int {",
            ),
            (
                "lib.rs",
                "use std::fmt;\n\n"
                + "// filler\n" * 400
                + "pub fn total(id: u32) -> u32 {\n    0\n}\n",
                "pub fn total(id: u32) -> u32 {",
            ),
            (
                "Orders.kt",
                "package shop\n\n"
                + "// filler\n" * 400
                + "suspend fun total(id: Int): Int = 0\n",
                "suspend fun total(id: Int): Int = 0",
            ),
        ],
    )
    def test_truncated_slice_keeps_the_declarations(
        self, project: Path, name: str, source: str, signature: str
    ) -> None:
        _write(project / name, source)
        result = CognitiveContextOptimizer(project_dir=project).optimize(
            prompt="unrelated wording",
            candidate_files=[name],
            token_budget=150,
        )
        piece = result.slices[0]
        assert piece.truncated
        assert signature in piece.content


class TestOptimizeRoute:
    def test_a_path_outside_the_project_is_never_read(
        self, client: TestClient, project: Path, tmp_path: Path
    ) -> None:
        outside = _write(tmp_path / "elsewhere.txt", "SECRET-CONTENT\n")
        _write(project / "Orders.cs", "public class Orders {}\n")
        body = client.post(
            "/api/cognitive-context/optimize",
            json={
                "prompt": "orders",
                "project_dir": str(project),
                "candidate_files": [str(outside), "Orders.cs"],
            },
        ).json()
        assert body["success"] is True
        context = body["context"]
        assert [s["file_path"] for s in context["slices"]] == ["Orders.cs"]
        assert context["refused"] == [{"path": str(outside), "reason": "outside"}]
        assert "SECRET-CONTENT" not in str(body)

    def test_without_candidates_the_project_sources_are_proposed(
        self, client: TestClient, project: Path
    ) -> None:
        _write(project / "orders" / "OrderService.cs", "public class OrderService {}\n")
        body = client.post(
            "/api/cognitive-context/optimize",
            json={"prompt": "order service", "project_dir": str(project)},
        ).json()
        assert body["success"] is True
        assert body["context"]["discovered"] is True
        assert body["context"]["slices"][0]["file_path"] == "orders/OrderService.cs"

    def test_a_project_is_required(self, client: TestClient) -> None:
        response = client.post(
            "/api/cognitive-context/optimize",
            json={"prompt": "x", "candidate_files": ["a.py"]},
        )
        assert response.status_code == 422
