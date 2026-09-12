"""What must hold of the real vendored renderer, whatever version it is.

These run the actual binary. That is the point: a test built on a hand-written
receipt tests our *idea* of archify, and the failure worth catching is an
upstream change to the receipt shape — a renamed field, a summary group that
stopped being emitted — which no fixture can see. Same reasoning as
`test_mobile_toolchain_contract.py`, which exists because sixty-four tests over
hand-written strings all agreed with each other about `adb` and none of them
agreed with `adb`.

They assert what must be true of *any* version, never that a particular
component or count exists: a vendored bump that legitimately changes the
examples is not a defect, and a test that says otherwise gets disabled.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from architecture_visualizer.archify import cli
from architecture_visualizer.archify import delta as delta_module
from architecture_visualizer.archify import ir as ir_module
from architecture_visualizer.archify.runtime import archify_root, check

pytestmark = pytest.mark.skipif(
    not check().ok, reason="archify cannot run here (see the doctor)"
)


@pytest.fixture(scope="module")
def examples() -> Path:
    root = archify_root()
    assert root is not None
    return root / "examples"


class TestDoctor:
    def test_the_vendored_tree_is_complete(self):
        """The trim is what this guards.

        `scripts/vendor_archify.py` drops upstream's tests and rendered
        examples; dropping one directory too many shows up here and nowhere
        else until someone opens the page.
        """
        receipt = cli.doctor()
        assert receipt.ok, receipt.stdout + receipt.stderr
        assert "ready" in receipt.stdout.lower()
        assert "[x]" not in receipt.stdout.lower()

    def test_the_vendor_receipt_records_the_pin(self):
        root = archify_root()
        assert root is not None
        vendor = json.loads((root / "VENDOR.json").read_text(encoding="utf-8"))
        assert vendor["source"].endswith("tt-a1i/archify")
        assert vendor["ref"].startswith("v")
        assert len(vendor["commit"]) == 40
        assert vendor["license"] == "MIT"

    def test_upstream_attribution_travels_with_the_code(self):
        """The licence is not optional, and a missing extra is not silent.

        `THIRD_PARTY_NOTICES.md` exists in some upstream releases and not
        others, so the vendoring script records which optional files were
        absent rather than skipping them quietly — that record is what stops
        "attribution stopped being copied" from going unnoticed.
        """
        root = archify_root()
        assert root is not None
        assert (root / "LICENSE").is_file()

        vendor = json.loads((root / "VENDOR.json").read_text(encoding="utf-8"))
        for name in vendor.get("absent_upstream", []):
            assert not (root / name).is_file()
        if not (root / "THIRD_PARTY_NOTICES.md").is_file():
            assert "THIRD_PARTY_NOTICES.md" in vendor.get("absent_upstream", [])


class TestValidate:
    def test_accepts_a_vendored_example_at_showcase_quality(self, examples: Path):
        receipt = cli.validate(examples / "web-app.architecture.json")
        assert receipt.ok, receipt.summary()
        assert receipt.error_count == 0

    def test_a_showcase_pass_reports_all_nine_artifact_checks(self, examples: Path):
        """Four checks is basic validation, never showcase acceptance."""
        receipt = cli.validate(examples / "web-app.architecture.json")
        assert len(receipt.payload.get("checks", [])) == 9

    def test_a_refusal_carries_actionable_diagnostics(self, tmp_path: Path):
        """The repair loop is only bounded by progress if refusals say why."""
        broken = tmp_path / "broken.arch.json"
        broken.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "diagram_type": "architecture",
                    "meta": {"title": "Broken"},
                    "components": [
                        {"id": "a", "type": "not-a-real-type", "label": "A"}
                    ],
                }
            ),
            encoding="utf-8",
        )
        receipt = cli.validate(broken)
        assert not receipt.ok
        assert receipt.error_count >= 1
        assert receipt.summary() != ""

    def test_a_relative_path_resolves_against_the_caller(
        self, tmp_path: Path, examples: Path
    ):
        """The subprocess runs with its cwd at the skill root.

        A relative caller path was being reinterpreted against that root, which
        surfaced as a missing-file error naming a path nobody wrote.
        """
        import os
        import shutil

        shutil.copy(examples / "web-app.architecture.json", tmp_path / "m.json")
        cwd = os.getcwd()
        try:
            os.chdir(tmp_path)
            assert cli.validate(Path("m.json")).ok
        finally:
            os.chdir(cwd)


class TestDeliver:
    def test_produces_a_self_contained_artifact(self, tmp_path: Path, examples: Path):
        out = tmp_path / "out.html"
        receipt = cli.deliver(examples / "web-app.architecture.json", out)
        assert receipt.ok, receipt.summary()
        assert out.is_file()
        html = out.read_text(encoding="utf-8", errors="ignore")
        assert "<svg" in html
        # Self-contained: the viewer must not reach the network to render.
        assert "http://" not in html.replace("http://www.w3.org", "")


class TestCompare:
    def test_reports_the_change_between_two_models(
        self, tmp_path: Path, examples: Path
    ):
        receipt = cli.compare(
            base=examples / "checkout-platform.base.architecture.json",
            head=examples / "checkout-platform.head.architecture.json",
            output=tmp_path / "delta.html",
            receipt=tmp_path / "delta.receipt.json",
        )
        assert receipt.ok, receipt.summary()
        assert (tmp_path / "delta.html").is_file()
        assert (tmp_path / "delta.receipt.json").is_file()

        summary = receipt.payload["summary"]
        # Shape, not values: the counters are what the UI renders, and a
        # renamed group is exactly the upstream change worth catching.
        assert {"components", "connections", "boundaries"} <= set(summary)
        assert {"added", "removed", "changed"} <= set(summary["components"])

    def test_the_status_record_survives_a_round_trip(
        self, tmp_path: Path, examples: Path
    ):
        spec_dir = tmp_path / "spec"
        status = delta_module.compare_models(
            spec_dir=spec_dir,
            baseline_path=examples / "checkout-platform.base.architecture.json",
            head_path=examples / "checkout-platform.head.architecture.json",
            project_dir=tmp_path,
        )
        assert status.status == delta_module.STATUS_MAPPED
        assert status.has_changes

        reread = delta_module.read_status(spec_dir)
        assert reread is not None
        assert reread.status == status.status
        assert reread.has_changes == status.has_changes

    def test_an_unreliable_pair_is_refused_before_the_comparison(
        self, tmp_path: Path, examples: Path
    ):
        """A delta over renamed ids is fiction; it must not reach the UI."""
        spec_dir = tmp_path / "spec"
        renamed = tmp_path / "renamed.arch.json"
        model = ir_module.load(examples / "checkout-platform.head.architecture.json")
        for index, component in enumerate(model["components"]):
            component["id"] = f"renamed-{index}"
        model["connections"] = []
        ir_module.save(renamed, model)

        status = delta_module.compare_models(
            spec_dir=spec_dir,
            baseline_path=examples / "checkout-platform.base.architecture.json",
            head_path=renamed,
            project_dir=tmp_path,
        )
        assert status.status == delta_module.STATUS_UNRELIABLE
        assert not status.has_changes
        assert not (spec_dir / delta_module.SUBDIR / delta_module.DELTA_HTML).exists()
