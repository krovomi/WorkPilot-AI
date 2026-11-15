"""The PR review's project context comes from WorkPilot's own context builder.

The reviewed project is read as data: whatever Python files it holds, even
under an ``apps/backend`` folder of its own, are never imported.
"""

from __future__ import annotations

import sys
from pathlib import Path

import context.builder as own_builder
from runners.github.services.deep_context_provider import DeepContextProvider


def _project_with_its_own_backend(root: Path) -> Path:
    package = root / "apps" / "backend" / "context"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "builder.py").write_text(
        "raise RuntimeError('the project was imported')\n", encoding="utf-8"
    )
    (root / "app.py").write_text("def run():\n    return 1\n", encoding="utf-8")
    return root


async def test_the_review_context_uses_workpilot_s_builder(tmp_path, monkeypatch):
    project = _project_with_its_own_backend(tmp_path / "project")
    built: list[Path] = []

    class Builder:
        def __init__(self, project_dir):
            built.append(Path(project_dir))

        def build_context(self, task, include_graph_hints):
            return type(
                "Context",
                (),
                {
                    "patterns_discovered": {"naming": "snake_case"},
                    "service_contexts": {
                        "api": {"framework": "FastAPI", "language": "Python"}
                    },
                    "files_to_reference": [
                        {"path": "app.py", "reason": "entry point"},
                        type("Ref", (), {"path": "", "reason": ""})(),
                    ],
                },
            )()

    monkeypatch.setattr(own_builder, "ContextBuilder", Builder)
    path_before = list(sys.path)

    found = await DeepContextProvider(project)._gather_project_context(
        "add login", ["app.py"]
    )

    assert built == [project.resolve()]
    assert sys.path == path_before
    assert found == {
        "patterns": {"naming": "snake_case"},
        "conventions": [
            "Service 'api' uses FastAPI framework",
            "Service 'api' is written in Python",
        ],
        "related_code": [{"path": "app.py", "reason": "entry point"}],
    }
