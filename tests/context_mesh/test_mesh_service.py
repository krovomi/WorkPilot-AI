"""The Context Mesh: its store on disk, its models and the analysis service.

The store writes to a temporary folder; the service registers real project
folders and analyses them with a stand-in model answer (the only seam), so the
prompt it builds and what it persists are what is checked.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import learning_loop.pattern_storage as pattern_storage
import pytest
from context_mesh.mesh_service import ContextMeshService
from context_mesh.storage import ContextMeshStorage
from context_mesh.types import (
    ContextMeshConfig,
    ContextualRecommendation,
    CrossProjectPattern,
    HandbookDomain,
    HandbookEntry,
    MeshAnalysisReport,
    PatternCategory,
    ProjectSummary,
    RecommendationType,
    SkillTransfer,
)


@pytest.fixture
def storage(tmp_path: Path) -> ContextMeshStorage:
    return ContextMeshStorage(tmp_path / "mesh")


def _pattern(pid: str = "cxp-1", **kw) -> CrossProjectPattern:
    return CrossProjectPattern(
        pattern_id=pid,
        category=kw.pop("category", "testing"),
        title=kw.pop("title", "Tests next to code"),
        description=kw.pop("description", "Each module has its test file"),
        source_projects=kw.pop("source_projects", ["web"]),
        **kw,
    )


def _entry(eid: str = "hbe-1") -> HandbookEntry:
    return HandbookEntry(eid, "testing", "Use pytest", "d", "r", ["api"])


def _transfer(tid: str = "skt-1") -> SkillTransfer:
    return SkillTransfer(tid, "Retry", "d", "api", ["web"], "error_handling")


def _rec(rid: str = "rec-1", target: str = "/p/web", **kw) -> ContextualRecommendation:
    return ContextualRecommendation(rid, "pattern_reuse", rid, "d", "api", target, **kw)


# ── Models ───────────────────────────────────────────────────────────


class TestModels:
    def test_enums_are_read_from_their_values(self):
        assert _pattern().category is PatternCategory.TESTING
        assert _entry().domain is HandbookDomain.TESTING
        assert _transfer().category is PatternCategory.ERROR_HANDLING
        assert _rec().recommendation_type is RecommendationType.PATTERN_REUSE

    def test_adoption_rate(self):
        assert _pattern().adoption_rate == 0.0
        assert _pattern(applied_count=3, dismissed_count=1).adoption_rate == 0.75

    def test_round_trips_drop_unknown_and_computed_keys(self):
        pattern = _pattern(applied_count=1)
        data = pattern.to_dict()
        assert data["adoption_rate"] == 1.0
        assert CrossProjectPattern.from_dict({**data, "extra": 1}) == pattern

        for item in (_entry(), _transfer(), _rec()):
            assert type(item).from_dict(item.to_dict()) == item
        summary = ProjectSummary("/p/web", "web", languages=["Go"])
        assert ProjectSummary.from_dict(summary.to_dict()) == summary
        config = ContextMeshConfig(enabled=True, max_projects=3)
        assert ContextMeshConfig.from_dict(config.to_dict()) == config

    def test_report_round_trip(self):
        report = MeshAnalysisReport(
            ["web"],
            [_pattern()],
            [_entry()],
            [_transfer()],
            [_rec()],
            analysis_model="m",
        )

        again = MeshAnalysisReport.from_dict(report.to_dict())

        assert again.to_dict() == report.to_dict()
        assert again.generated_at == report.generated_at

    def test_ids(self):
        assert ProjectSummary.generate_id("/p") == ProjectSummary.generate_id("/p")
        assert ProjectSummary.generate_id("/p").startswith("proj-")
        assert CrossProjectPattern.generate_id().startswith("cxp-")
        assert HandbookEntry.generate_id().startswith("hbe-")
        assert SkillTransfer.generate_id().startswith("skt-")
        assert ContextualRecommendation.generate_id().startswith("rec-")


# ── Storage ──────────────────────────────────────────────────────────


class TestStorage:
    def test_the_default_folder_is_under_the_home(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))

        assert ContextMeshStorage().mesh_dir == tmp_path / ".workpilot" / "context_mesh"

    def test_config(self, storage):
        assert storage.load_config() == ContextMeshConfig()
        storage.save_config(ContextMeshConfig(enabled=True))

        assert storage.load_config().enabled is True

    def test_projects_are_replaced_by_path(self, storage):
        storage.save_project(ProjectSummary("/p/web", "web"))
        storage.save_project(ProjectSummary("/p/api", "api"))
        storage.save_project(ProjectSummary("/p/web", "web-renamed"))

        assert [p.project_name for p in storage.get_projects()] == [
            "web-renamed",
            "api",
        ]
        storage.remove_project("/p/web")
        assert [p.project_name for p in storage.get_projects()] == ["api"]

    def test_patterns_and_handbook_are_replaced_by_id(self, storage):
        storage.add_pattern(_pattern("a"))
        storage.add_pattern(_pattern("b"))
        storage.add_pattern(_pattern("a", title="New title"))
        storage.add_handbook_entry(_entry("x"))
        storage.add_handbook_entry(_entry("x"))
        storage.add_handbook_entry(_entry("y"))

        assert [(p.pattern_id, p.title) for p in storage.get_patterns()] == [
            ("a", "New title"),
            ("b", "Tests next to code"),
        ]
        storage.remove_pattern("a")
        storage.remove_handbook_entry("x")
        assert [p.pattern_id for p in storage.get_patterns()] == ["b"]
        assert [e.entry_id for e in storage.get_handbook_entries()] == ["y"]

    def test_statuses_are_updated_in_place(self, storage):
        storage.save_skill_transfers([_transfer("t1"), _transfer("t2")])
        storage.save_recommendations([_rec("r1"), _rec("r2", target="/p/api")])

        assert storage.update_skill_transfer_status("t2", "accepted")
        assert not storage.update_skill_transfer_status("nope", "accepted")
        assert storage.update_recommendation_status("r1", "applied")
        assert not storage.update_recommendation_status("nope", "applied")

        assert [t.status for t in storage.get_skill_transfers()] == [
            "pending",
            "accepted",
        ]
        assert [r.status for r in storage.get_recommendations()] == [
            "applied",
            "active",
        ]
        assert [r.recommendation_id for r in storage.get_recommendations("/p/api")] == [
            "r2"
        ]

    def test_summary(self, storage):
        storage.save_project(ProjectSummary("/p/web", "web"))
        storage.add_pattern(_pattern())
        storage.save_skill_transfers([_transfer()])
        storage.save_recommendations([_rec("r1"), _rec("r2", status="dismissed")])

        assert storage.get_summary() == {
            "project_count": 1,
            "pattern_count": 1,
            "handbook_entry_count": 0,
            "skill_transfer_count": 1,
            "recommendation_count": 2,
            "active_recommendations": 1,
            "pending_transfers": 1,
            "projects": [{"name": "web", "path": "/p/web"}],
        }

    def test_the_last_report(self, storage):
        assert storage.get_last_report() is None
        storage.save_report(MeshAnalysisReport(["web"], [_pattern()], [], [], []))

        assert storage.get_last_report().analyzed_projects == ["web"]

    def test_unreadable_files_read_as_empty(self, storage):
        (storage.mesh_dir / "patterns.json").write_text("{broken", encoding="utf-8")
        (storage.mesh_dir / "projects.json").write_text("[]", encoding="utf-8")
        (storage.mesh_dir / "handbook.json").write_text(
            '{"entries": "x"}', encoding="utf-8"
        )
        (storage.mesh_dir / "config.json").write_text("[1]", encoding="utf-8")
        (storage.mesh_dir / "last_report.json").write_text(
            '{"patterns_found": [{"category": "nope"}]}', encoding="utf-8"
        )

        assert storage.get_patterns() == []
        assert storage.get_projects() == []
        assert storage.get_handbook_entries() == []
        assert storage.load_config() == ContextMeshConfig()
        assert storage.get_last_report() is None

    def test_one_bad_record_does_not_hide_the_others(self, storage, caplog):
        good = _rec("good").to_dict()
        (storage.mesh_dir / "recommendations.json").write_text(
            json.dumps(
                {
                    "recommendations": [
                        {**good, "recommendation_type": "retired_type"},
                        "not a record",
                        good,
                    ]
                }
            ),
            encoding="utf-8",
        )

        assert [r.recommendation_id for r in storage.get_recommendations()] == ["good"]
        assert caplog.text.count("Skipped an unreadable record") == 2

    def test_a_failed_write_is_false_and_keeps_the_old_file(self, storage, monkeypatch):
        storage.save_patterns([_pattern("kept")])

        def refuse(*_a, **_k):
            raise PermissionError("read-only")

        monkeypatch.setattr("context_mesh.storage.write_json_atomic", refuse)

        assert storage.save_patterns([]) is False
        assert [p.pattern_id for p in storage.get_patterns()] == ["kept"]

    def test_values_json_cannot_hold_are_written_as_text(self, storage):
        assert storage._write_json(storage.mesh_dir / "x.json", {"at": Path("a")})

        assert json.loads(
            (storage.mesh_dir / "x.json").read_text(encoding="utf-8")
        ) == {"at": "a"}


# ── Service ──────────────────────────────────────────────────────────


def _write(root: Path, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    return root


@pytest.fixture
def service(storage) -> ContextMeshService:
    return ContextMeshService(storage=storage, model="haiku")


@pytest.fixture
def web(tmp_path) -> Path:
    return _write(
        tmp_path / "web",
        {
            "package.json": json.dumps(
                {
                    "dependencies": {"react": "19", "express": "5"},
                    "devDependencies": {"vitest": "3"},
                }
            ),
            "Dockerfile": "FROM node\n",
            "src/app.tsx": "export {}\n",
            "node_modules/x/index.js": "",
            "ignore me.txt": "",
        },
    )


@pytest.fixture
def api(tmp_path) -> Path:
    return _write(
        tmp_path / "api",
        {
            "requirements.txt": (
                "# runtime\nfastapi==0.115\n-r base.txt\nrequests>=2 ; python_version>'3'\n"
                "uvicorn[standard]\n"
            ),
            "Api.csproj": "<Project/>",
            "main.py": "print('hi')\n",
            "Services/Orders.cs": "class Orders {}\n",
        },
    )


@pytest.fixture
def no_patterns(monkeypatch):
    class Empty:
        def __init__(self, _path):
            pass

        def load_patterns(self):
            return []

    monkeypatch.setattr(pattern_storage, "PatternStorage", Empty)


class TestRegistration:
    def test_the_stack_comes_from_the_shared_detector(self, service, web, api):
        front = service.register_project(str(web))
        back = service.register_project(str(api))

        assert front.project_path == str(web.resolve())
        assert front.tech_stack == ["javascript/typescript", "docker"]
        assert front.languages == ["TypeScript"]
        assert {"react", "express"} <= set(front.frameworks)
        assert back.tech_stack == ["c#", "python"]
        assert back.languages == ["C#", "Python"]
        assert "fastapi" in back.frameworks
        assert [p.project_name for p in service.get_projects()] == ["web", "api"]

    def test_a_windev_project(self, service, tmp_path):
        project = _write(tmp_path / "erp", {"Erp.wdp": "", "Main.wdw": ""})

        assert "windev" in service.register_project(str(project)).frameworks

    def test_a_missing_folder_is_refused(self, service, tmp_path):
        with pytest.raises(ValueError, match="Project directory not found"):
            service.register_project(str(tmp_path / "gone"))

    def test_an_unreadable_subfolder_is_skipped(self, service, web, monkeypatch):
        real = Path.iterdir

        def guarded(self):
            if self.name == "src":
                raise PermissionError("no")
            return real(self)

        monkeypatch.setattr(Path, "iterdir", guarded)

        assert service.register_project(str(web)).languages == []

    def test_unregister_accepts_the_path_as_typed(self, service, web, monkeypatch):
        service.register_project(str(web))
        monkeypatch.chdir(web.parent)

        assert service.unregister_project("web")
        assert service.get_projects() == []

    def test_unregister_with_the_registered_path(self, service, web):
        service.register_project(str(web))

        assert service.unregister_project(str(web.resolve()))
        assert service.get_projects() == []


ANSWER = {
    "patterns": [
        {
            "category": "testing",
            "title": "Colocated tests",
            "description": "Tests sit next to code",
            "source_projects": ["web", "api"],
            "target_projects": [],
            "confidence": 0.9,
        },
        {"category": "testing", "title": "Weak", "confidence": 0.2},
        {"category": "not-a-category", "title": "Bad"},
        {"category": "testing", "confidence": "high"},
        "not an object",
    ],
    "handbook_entries": [
        {"domain": "backend", "title": "FastAPI for APIs", "source_projects": ["api"]},
        {"domain": "unknown"},
    ],
    "skill_transfers": [
        {"skill_name": "Retry", "category": "error_handling", "source_project": "api"},
        {"category": "nope"},
    ],
    "recommendations": [
        {
            "recommendation_type": "convention_adoption",
            "title": "Adopt vitest",
            "target_project": "api",
            "relevance_score": 0.8,
            "phase": "coding",
        },
        {"title": "Elsewhere", "target_project": "unregistered"},
        {"recommendation_type": "nope"},
    ],
}


class TestAnalysis:
    def test_no_project_is_an_empty_report(self, service):
        report = asyncio.run(service.run_analysis())

        assert report.analyzed_projects == []
        assert report.patterns_found == []

    def test_an_analysis_parses_persists_and_counts(
        self, service, storage, web, api, monkeypatch, no_patterns
    ):
        service.register_project(str(web))
        service.register_project(str(api))
        storage.add_pattern(_pattern("old", title="Existing one"))
        storage.add_handbook_entry(_entry("old-entry"))
        prompts: list[str] = []

        async def model(self, prompt, projects):
            prompts.append(prompt)
            return "Here you go:\n```json\n" + json.dumps(ANSWER) + "\n```\n"

        monkeypatch.setattr(ContextMeshService, "_run_ai_analysis", model)
        statuses: list[str] = []

        report = asyncio.run(service.run_analysis(statuses.append))

        assert statuses == [
            "Analyzing 2 project(s)...",
            "Running AI analysis across projects...",
            "Processing analysis results...",
            "Analysis complete!",
        ]
        assert [p.title for p in report.patterns_found] == ["Colocated tests"]
        assert [e.title for e in report.handbook_entries] == ["FastAPI for APIs"]
        assert [t.skill_name for t in report.skill_transfers] == ["Retry"]
        assert [(r.title, r.target_project) for r in report.recommendations] == [
            ("Adopt vitest", str(api.resolve())),
            ("Elsewhere", "unregistered"),
        ]
        assert report.analysis_model == "haiku"
        assert {p.title for p in storage.get_patterns()} == {
            "Existing one",
            "Colocated tests",
        }
        assert len(storage.get_skill_transfers()) == 1
        assert [p.pattern_count for p in storage.get_projects()] == [1, 1]
        assert all(p.last_analyzed_at for p in storage.get_projects())
        assert storage.get_last_report().patterns_found[0].title == "Colocated tests"

        [prompt] = prompts
        assert prompt.count("<user_content>") == 3  # two projects + the knowledge
        assert "- Dependencies: react, express" in prompt
        assert "- Dev dependencies: vitest" in prompt
        assert "- Python deps: fastapi, requests, uvicorn" in prompt
        assert "- Top-level dirs: src" in prompt
        assert "- [testing] Existing one: Each module has its test file" in prompt
        assert "- [testing] Use pytest" in prompt

    def test_recommendations_follow_the_registered_path(
        self, service, storage, api, monkeypatch, no_patterns
    ):
        service.register_project(str(api))

        async def model(self, prompt, projects):
            return json.dumps(ANSWER)

        monkeypatch.setattr(ContextMeshService, "_run_ai_analysis", model)
        asyncio.run(service.run_analysis())

        found = asyncio.run(
            service.get_recommendations_for_project(str(api), phase="coding")
        )
        assert [r.title for r in found] == ["Adopt vitest"]
        assert (
            asyncio.run(service.get_recommendations_for_project(str(api), phase="qa"))
            == []
        )

    def test_an_answer_without_json_is_an_empty_report(
        self, service, web, monkeypatch, no_patterns
    ):
        service.register_project(str(web))

        async def model(self, prompt, projects):
            return "I could not analyse these projects."

        monkeypatch.setattr(ContextMeshService, "_run_ai_analysis", model)
        report = asyncio.run(service.run_analysis())

        assert report.analyzed_projects == ["web"]
        assert report.patterns_found == []
        assert report.analysis_model == ""

    def test_learning_patterns_reach_the_prompt(self, service, web, monkeypatch):
        class Stored:
            def __init__(self, path):
                self.path = path

            def load_patterns(self):
                return [
                    SimpleNamespace(
                        category=SimpleNamespace(value="convention"),
                        description="Use pnpm",
                    )
                ]

        monkeypatch.setattr(pattern_storage, "PatternStorage", Stored)
        service.register_project(str(web))

        context = service._gather_projects_context(service.get_projects())

        assert "- Learning patterns (1):\n  - [convention] Use pnpm" in context

    def test_unreadable_manifests_and_vault_are_left_out(
        self, service, tmp_path, monkeypatch
    ):
        project = _write(
            tmp_path / "odd",
            {"package.json": "{not json", "requirements.txt": "\n# only comments\n"},
        )

        class Broken:
            def __init__(self, _path):
                raise RuntimeError("vault offline")

        monkeypatch.setattr(pattern_storage, "PatternStorage", Broken)
        service.register_project(str(project))
        (project / "requirements.txt").write_bytes(b"\xff\xfe")

        context = service._gather_projects_context(service.get_projects())

        assert "Dependencies" not in context
        assert "Python deps" not in context
        assert "Learning patterns" not in context

    def test_a_project_folder_gone_since_registration(self, service, tmp_path):
        service.storage.save_project(ProjectSummary(str(tmp_path / "gone"), "gone"))

        context = service._gather_projects_context(service.get_projects())

        assert "### gone" in context
        assert "Top-level dirs" not in context

    def test_no_knowledge_yet(self, service):
        assert service._gather_existing_knowledge() == "No existing knowledge yet."


class TestExtractJson:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ('{"a": 1}', {"a": 1}),
            ('```json\n{"a": 2}\n```', {"a": 2}),
            ('Result:\n```\n{"a": 3}\n```', {"a": 3}),
            ('noise {"a": 4} trailing', {"a": 4}),
            ("```json\n{broken\n```", None),
            ("{ not json }", None),
            ("plain words", None),
            ("", None),
        ],
    )
    def test_extract(self, service, text, expected):
        assert service._extract_json(text) == expected

    def test_a_json_list_is_not_an_answer(self, service):
        report = service._parse_analysis_results("[1, 2]", [])

        assert report.patterns_found == []

    def test_a_section_that_is_not_a_list_is_empty(self, service):
        report = service._parse_analysis_results('{"patterns": "many"}', [])

        assert report.patterns_found == []
        assert report.analysis_model == "haiku"
