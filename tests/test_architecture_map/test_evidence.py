"""The repository evidence handed to the architecture author.

Every test reads a real directory: the evidence is what the files say, so a
double of the file system would only test the double.
"""

from __future__ import annotations

import json
from pathlib import Path

from architecture_visualizer.archify import evidence


def write(root: Path, rel: str, text: str = "") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def small_project(root: Path) -> Path:
    """Three Python modules, one importing the other two."""
    write(root, "app/__init__.py")
    write(root, "app/main.py", "from app import models\nfrom app import store\n")
    write(root, "app/models.py", "X = 1\n")
    write(root, "app/store.py", "from app import models\n")
    return root


class TestUnderAnIgnoredName:
    """A project kept under `build/` or `dist/` is still read."""

    def test_entrypoints_and_manifests_of_a_project_under_build(self, tmp_path):
        root = tmp_path / "build" / "dist" / "proj"
        write(root, "main.py", "print('hi')\n")
        write(root, "package.json", json.dumps({"dependencies": {"react": "1"}}))
        write(root, "Dockerfile", "FROM scratch\n")

        found = evidence.collect(root)

        assert found.entrypoints == ["main.py"]
        assert found.manifests == {"package.json": ["react"]}
        assert found.infrastructure == ["Dockerfile"]

    def test_vendored_folders_inside_the_project_are_skipped(self, tmp_path):
        write(tmp_path, "node_modules/x/index.js")
        write(tmp_path, "node_modules/x/package.json", '{"dependencies": {"a": "1"}}')
        write(tmp_path, ".venv/lib/Dockerfile")
        write(tmp_path, "dist/main.js")

        found = evidence.collect(tmp_path)

        assert found.entrypoints == []
        assert found.manifests == {}
        assert found.infrastructure == []

    def test_infrastructure_under_build_inside_the_project_counts(self, tmp_path):
        # A `build/Dockerfile` names a runtime boundary: only the folders of
        # other people's code are skipped for infrastructure.
        write(tmp_path, "build/Dockerfile", "FROM scratch\n")
        write(tmp_path, "node_modules/pkg/Dockerfile", "FROM scratch\n")

        assert evidence.collect(tmp_path).infrastructure == ["build/Dockerfile"]


class TestManifests:
    def test_package_json_names_dependencies_and_peers_sorted(self, tmp_path):
        write(
            tmp_path,
            "web/package.json",
            json.dumps(
                {
                    "dependencies": {"zod": "1", "react": "18"},
                    "peerDependencies": {"react": "18", "vite": "5"},
                    "devDependencies": {"vitest": "1"},
                }
            ),
        )

        assert evidence.collect(tmp_path).manifests == {
            "web/package.json": ["react", "vite", "zod"]
        }

    def test_package_json_with_a_dependency_list_is_read_as_empty(self, tmp_path):
        write(tmp_path, "package.json", json.dumps({"dependencies": ["react"]}))
        write(tmp_path, "other/package.json", json.dumps({"dependencies": "react"}))

        assert evidence.collect(tmp_path).manifests == {}

    def test_package_json_that_is_not_an_object_or_not_json(self, tmp_path):
        write(tmp_path, "a/package.json", "[1, 2]")
        write(tmp_path, "b/package.json", "{not json")
        (tmp_path / "c").mkdir()
        (tmp_path / "c" / "package.json").write_bytes(b"\xff\xfe{}")

        assert evidence.collect(tmp_path).manifests == {}

    def test_pyproject_names_without_versions_or_extras(self, tmp_path):
        write(
            tmp_path,
            "pyproject.toml",
            "[project]\n"
            'dependencies = ["fastapi>=0.100", "uvicorn[standard]==0.30", '
            '"httpx<1", "pydantic", 3]\n',
        )

        assert evidence.collect(tmp_path).manifests == {
            "pyproject.toml": ["fastapi", "httpx", "pydantic", "uvicorn"]
        }

    def test_pyproject_of_other_shapes_gives_nothing(self, tmp_path):
        write(tmp_path, "a/pyproject.toml", 'project = "x"\n')
        write(tmp_path, "b/pyproject.toml", '[project]\ndependencies = "fastapi"\n')
        write(tmp_path, "c/pyproject.toml", "[tool.ruff]\nline-length = 88\n")
        write(tmp_path, "d/pyproject.toml", "[project\n")
        (tmp_path / "e").mkdir()
        (tmp_path / "e" / "pyproject.toml").write_bytes(b"\xff[project]")

        assert evidence.collect(tmp_path).manifests == {}

    def test_requirements_skip_comments_options_and_blank_lines(self, tmp_path):
        write(
            tmp_path,
            "requirements.txt",
            "# pinned\n\nrequests==2.31\n-r base.txt\n  --index-url x\n"
            "rich[jupyter]>=13\nclick<9\n",
        )

        assert evidence.collect(tmp_path).manifests == {
            "requirements.txt": ["click", "requests", "rich"]
        }

    def test_requirements_not_in_utf8_give_nothing(self, tmp_path):
        (tmp_path / "requirements.txt").write_bytes(b"requests\n\xff\xfe\n")

        assert evidence.collect(tmp_path).manifests == {}

    def test_manifests_without_a_reader_are_not_listed(self, tmp_path):
        write(tmp_path, "go.mod", "module x\n")
        write(tmp_path, "Cargo.toml", "[package]\n")

        assert evidence.collect(tmp_path).manifests == {}

    def test_dependencies_per_manifest_are_capped(self, tmp_path):
        names = "\n".join(f"pkg{i:03d}" for i in range(evidence.MAX_DEPENDENCIES + 5))
        write(tmp_path, "requirements.txt", names)

        listed = evidence.collect(tmp_path).manifests["requirements.txt"]

        assert len(listed) == evidence.MAX_DEPENDENCIES
        assert listed[0] == "pkg000"

    def test_at_most_eight_manifests_are_read(self, tmp_path):
        for i in range(10):
            write(tmp_path, f"svc{i}/requirements.txt", f"dep{i}\n")

        assert len(evidence.collect(tmp_path).manifests) == 8


class TestCeilings:
    def test_entrypoints_are_capped(self, tmp_path):
        for i in range(evidence.MAX_ENTRYPOINTS + 3):
            write(tmp_path, f"svc{i:02d}/main.py")

        assert len(evidence.collect(tmp_path).entrypoints) == evidence.MAX_ENTRYPOINTS

    def test_infrastructure_is_capped_at_twenty(self, tmp_path):
        for i in range(25):
            write(tmp_path, f"svc{i:02d}/Dockerfile")

        assert len(evidence.collect(tmp_path).infrastructure) == 20

    def test_edges_are_capped(self, tmp_path, monkeypatch):
        small_project(tmp_path)
        monkeypatch.setattr(evidence, "MAX_EDGES", 1)

        assert len(evidence.collect(tmp_path).edges) == 1


class TestGraph:
    def test_modules_ranked_by_degree_with_edges_between_them(self, tmp_path):
        found = evidence.collect(small_project(tmp_path))

        paths = [m["path"] for m in found.modules]
        # models is imported twice, main imports twice, store once each way.
        assert set(paths[:2]) == {"app/main.py", "app/models.py"}
        assert paths[2] == "app/store.py"
        models = next(m for m in found.modules if m["path"] == "app/models.py")
        assert models == {
            "path": "app/models.py",
            "language": "python",
            "lines": 2,
            "importedBy": 2,
            "imports": 0,
        }
        assert sorted(found.edges) == [
            ("app/main.py", "app/models.py"),
            ("app/main.py", "app/store.py"),
            ("app/store.py", "app/models.py"),
        ]
        assert found.languages == {"python": 3}

    def test_edges_to_modules_left_out_of_the_ranking_are_dropped(
        self, tmp_path, monkeypatch
    ):
        small_project(tmp_path)
        monkeypatch.setattr(evidence, "MAX_MODULES", 2)

        found = evidence.collect(tmp_path)

        assert {m["path"] for m in found.modules} == {"app/main.py", "app/models.py"}
        assert found.edges == [("app/main.py", "app/models.py")]

    def test_to_dict_is_json_ready(self, tmp_path):
        found = evidence.collect(small_project(tmp_path))

        data = json.loads(json.dumps(found.to_dict()))

        assert data["projectDir"] == str(tmp_path)
        assert ["app/store.py", "app/models.py"] in data["edges"]
        assert data["languages"] == {"python": 3}
        assert set(data) == {
            "projectDir",
            "modules",
            "edges",
            "entrypoints",
            "manifests",
            "infrastructure",
            "languages",
        }


class TestRenderSection:
    def test_an_empty_repository_renders_only_the_heading(self, tmp_path):
        assert evidence.render_section(evidence.Evidence(project_dir=tmp_path)) == (
            "## Repository evidence (measured, not inferred)\n"
        )

    def test_every_part_is_rendered_and_labelled(self, tmp_path):
        found = evidence.Evidence(
            project_dir=tmp_path,
            modules=[
                {
                    "path": "app/main.py",
                    "language": "python",
                    "lines": 12,
                    "importedBy": 0,
                    "imports": 2,
                }
            ],
            edges=[("app/main.py", "app/models.py")],
            entrypoints=["app/main.py"],
            manifests={"requirements.txt": ["click", "rich"]},
            infrastructure=["Dockerfile"],
            languages={"python": 3, "javascript": 1},
        )

        text = evidence.render_section(found)

        assert "**Languages.** python (3 files), javascript (1 files)" in text
        assert "**Entrypoints.**\n- `app/main.py`" in text
        assert "**Deployment and runtime boundaries.**\n- `Dockerfile`" in text
        assert "| `app/main.py` | python | 12 | 0 | 2 |" in text
        assert "- `app/main.py` → `app/models.py`" in text
        assert "- `requirements.txt`: click, rich" in text
        # The order is the order a reader needs: what, where it starts, what
        # it deploys as, then the graph and what it talks to.
        order = [
            text.index(marker)
            for marker in (
                "**Languages.**",
                "**Entrypoints.**",
                "**Deployment",
                "**Most connected",
                "**Import edges",
                "**Declared dependencies.**",
            )
        ]
        assert order == sorted(order)
