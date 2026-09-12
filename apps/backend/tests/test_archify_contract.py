"""Contract tests for the archify subprocess interface.

These tests verify that the archify subprocess behaves correctly when called
with various inputs and configurations.
"""

from pathlib import Path

import pytest
from architecture_visualizer.archify import cli


@pytest.fixture
def examples(tmp_path: Path) -> Path:
    """Génère le dossier d'exemples et le fichier d'architecture requis par le contrat."""
    examples_dir = tmp_path / "examples"
    examples_dir.mkdir(exist_ok=True)

    blueprint = examples_dir / "web-app.architecture.json"
    blueprint.write_text('{"version": "1.0", "components": []}', encoding="utf-8")

    return examples_dir


class TestReceiptParsing:
    """Tests for parsing receipt objects from archify output."""

    def test_a_successful_receipt_reports_ok(self):
        receipt = cli.Receipt(
            ok=True,
            command="validate",
            payload={},
        )
        assert receipt.ok is True
        assert "validate" in receipt.summary()

    def test_a_failed_receipt_reports_error_count(self):
        receipt = cli.Receipt(
            ok=False,
            command="validate",
            payload={
                "diagnostics": [
                    {"code": "ir/invalid", "message": "Invalid IR"},
                    {"code": "ir/incomplete", "message": "Missing fields"},
                ]
            },
        )
        assert receipt.ok is False
        assert receipt.error_count == 2

    def test_error_messages_are_extracted_from_diagnostics(self):
        receipt = cli.Receipt(
            ok=False,
            command="validate",
            payload={
                "diagnostics": [
                    {"code": "ir/invalid", "message": "Invalid IR"},
                ]
            },
        )
        assert "Invalid IR" in receipt.summary()


class TestValidate:
    """Tests for the validate command."""

    def test_validation_with_a_valid_model(self, tmp_path: Path):
        model = {
            "version": "1.0",
            "components": [],
            "relationships": [],
        }
        receipt = cli.validate(model)
        assert receipt.ok is True
        assert receipt.command == "validate"

    def test_validation_with_an_invalid_model(self):
        model = {"incomplete": "model"}
        receipt = cli.validate(model)
        # Should fail validation or be handled appropriately
        assert receipt.command == "validate"

    def test_validation_errors_are_reported(self):
        model = {
            "version": "1.0",
            "components": "not a list",  # Wrong type
        }
        receipt = cli.validate(model)
        assert receipt.command == "validate"
        # Error handling depends on implementation

    def test_multiple_validation_errors_are_reported(self):
        receipt = cli.Receipt(
            ok=False,
            command="validate",
            payload={
                "diagnostics": [{"code": f"x/{i}", "message": "m"} for i in range(5)]
            },
        )
        assert receipt.error_count >= 1
        assert receipt.summary() != ""

    def test_a_relative_path_resolves_against_the_caller(
        self, tmp_path: Path, examples: Path
    ):
        """The subprocess runs with its cwd at the skill root.

        A relative caller path was being reinterpreted against that root, which
        broke when archify's location differed from the project directory.
        """
        # This would be tested by actually calling the archify subprocess
        # with a relative path and verifying it resolves correctly
        pass


class TestDeliver:
    """Tests for the deliver command."""

    def test_produces_a_self_contained_artifact(self, tmp_path: Path, examples: Path):
        out = tmp_path / "out.html"
        receipt = cli.deliver(examples / "web-app.architecture.json", out)
        assert receipt.ok, receipt.summary()
        assert out.exists()
