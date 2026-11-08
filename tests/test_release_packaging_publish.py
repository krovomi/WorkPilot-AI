"""The build jobs of a release package; only ``create-release`` publishes (F171).

electron-builder publishes on its own when it runs on a tag: ``--publish`` left
unset means "onTag". Since a tag pushed with PAT_TOKEN starts release.yml (no
longer only a dispatch on ``main``), every build job of 1.4.0 tried to create
the GitHub release with its read-only ``GITHUB_TOKEN`` and stopped on a 403
before any file was built. The release itself belongs to ``create-release``,
after the smoke tests and the checksums.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / ".github" / "workflows" / "release.yml"


def _packaging_steps() -> list[tuple[str, str]]:
    workflow = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    found = []
    for job_name, job in workflow["jobs"].items():
        for step in job.get("steps", []):
            run = str(step.get("run", ""))
            if "pnpm run package" in run:
                found.append((f"{job_name}: {step.get('name')}", run))
    return found


def test_every_platform_is_packaged_by_the_release():
    names = " ".join(name for name, _ in _packaging_steps())
    for platform in ("macOS (Intel)", "macOS (Apple Silicon)", "Windows", "Linux"):
        assert platform in names, f"no packaging step for {platform}"


def test_no_packaging_step_lets_electron_builder_publish():
    for name, run in _packaging_steps():
        assert "--publish never" in run, (
            f"{name} must pass --publish never: on a tag electron-builder "
            "creates the release itself with the job's read-only token"
        )
