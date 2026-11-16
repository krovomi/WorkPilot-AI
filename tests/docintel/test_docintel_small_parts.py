"""The small parts every docintel reader leans on, at their edges.

Which files are the task's, the `Read` guard, the secret masking, the C4
readers, the CI reading and the card's numbers. Each is checked on the input
that the end-to-end tests never produce: a requirements file of another shape,
a symlink, a scanner that cannot load, a workspace with nothing in it.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from docintel import diagnostics, files, read_guard, redact, settings
from docintel.c4 import parse_c4_plantuml, parse_structurizr
from docintel.engines.base import OcrBox
from docintel.models import DiagramModel, DiagramNode, ExtractedDocument


@pytest.fixture
def spec(tmp_path) -> Path:
    spec = tmp_path / "shop" / ".workpilot" / "specs" / "001-orders"
    (spec / "attachments").mkdir(parents=True)
    return spec


# ---------------------------------------------------------------------------
# the task's files


class TestTaskFiles:
    def test_a_spec_outside_a_project_has_no_project(self, tmp_path):
        assert files.project_of(tmp_path / "loose") is None

    def test_listed_attachments_are_kept_once_and_only_inside_the_spec(
        self, spec, tmp_path
    ):
        (spec / "attachments" / "a.png").write_bytes(b"a")
        (spec / "shots").mkdir()
        (spec / "shots" / "b.png").write_bytes(b"b")
        (tmp_path / "outside.png").write_bytes(b"o")
        (spec / "requirements.json").write_text(
            json.dumps(
                {
                    "attached_images": [
                        {"path": "shots/b.png"},
                        {"path": "attachments/a.png"},  # already found on disk
                        {"path": "../../../../outside.png"},
                        {"name": "no path"},
                        "not an entry",
                    ]
                }
            ),
            encoding="utf-8",
        )

        found = files.attachment_paths(spec)

        assert [p.relative_to(spec).as_posix() for p in found] == [
            "attachments/a.png",
            "shots/b.png",
        ]

    @pytest.mark.parametrize(
        "body", ["[1, 2]", '{"attached_images": "shots/b.png"}', "{broken"]
    )
    def test_a_requirements_file_of_another_shape_lists_nothing_more(self, spec, body):
        (spec / "attachments" / "a.png").write_bytes(b"a")
        (spec / "requirements.json").write_text(body, encoding="utf-8")

        assert [p.name for p in files.attachment_paths(spec)] == ["a.png"]

    def test_a_cosmetic_pass_that_fails_keeps_the_text(self, monkeypatch):
        import watermarks.clean

        def broken(_text):
            raise RuntimeError("cleaner bug")

        monkeypatch.setattr(watermarks.clean, "clean_generated", broken)

        assert files.clean("plain text") == "plain text"


# ---------------------------------------------------------------------------
# the Read guard


def _guarded_spec(spec: Path) -> Path:
    original = spec / "attachments" / "secret.png"
    original.write_bytes(b"png")
    (spec / "docintel").mkdir()
    (spec / "docintel" / "result.json").write_text(
        json.dumps(
            {
                "documents": [
                    {"path": "attachments/secret.png", "status": "withheld"},
                    {"path": "", "status": "redacted"},
                ]
            }
        ),
        encoding="utf-8",
    )
    return original


class TestReadGuard:
    def _ask(self, hook, tool_input):
        return asyncio.run(hook({"tool_name": "Read", "tool_input": tool_input}))

    def test_a_read_without_a_path_or_outside_the_spec_is_not_its_business(
        self, spec, tmp_path
    ):
        _guarded_spec(spec)
        hook = read_guard.make_read_guard_hook(spec)

        assert self._ask(hook, {}) == {}
        assert self._ask(hook, "not a dict") == {}
        assert self._ask(hook, {"file_path": str(tmp_path / "elsewhere.png")}) == {}

    def test_the_withheld_original_is_refused(self, spec):
        original = _guarded_spec(spec)
        hook = read_guard.make_read_guard_hook(str(spec))

        answer = self._ask(hook, {"file_path": str(original)})

        decision = answer["hookSpecificOutput"]["permissionDecision"]
        assert decision == "deny"

    def test_a_path_that_cannot_be_resolved_is_not_guarded(self, monkeypatch):
        def loop(self, strict=False):
            raise RuntimeError("symlink loop")

        monkeypatch.setattr(Path, "resolve", loop)

        assert read_guard._resolved(Path("x")) is None

    def test_without_a_spec_the_hook_lets_every_read_through(self):
        hook = read_guard.make_read_guard_hook(None)

        assert self._ask(hook, {"file_path": "/etc/hosts"}) == {}


# ---------------------------------------------------------------------------
# the secret masking


class _Match:
    def __init__(self, line_number, matched_text, pattern_name="Token"):
        self.line_number = line_number
        self.matched_text = matched_text
        self.pattern_name = pattern_name


class TestRedaction:
    def test_a_scanner_that_cannot_load_is_reported_unavailable(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "security.scan_secrets", None)

        with pytest.raises(redact.ScannerUnavailable):
            redact.find_secrets("anything")

    def test_a_match_the_text_does_not_hold_is_dropped(self, monkeypatch):
        matches = [
            _Match(9, "elsewhere"),
            _Match(1, "not on this line"),
            _Match(1, "k"),
        ]
        monkeypatch.setattr(redact, "_scan_content", lambda: lambda text, src: matches)

        findings = redact.find_secrets("a k b")

        assert [(f.line, f.start, f.end) for f in findings] == [(0, 2, 3)]

    def test_overlapping_findings_are_masked_once(self):
        findings = [
            redact.SecretFinding("Password", 0, 4, 12),
            redact.SecretFinding("Connection string", 0, 0, 8),
        ]

        masked = redact.mask_text("pwd=abcdefgh;rest", findings)

        assert masked == "[REDACTED: Connection string];rest"

    def test_without_pillow_nothing_is_painted(self, monkeypatch, tmp_path):
        monkeypatch.setitem(sys.modules, "PIL.Image", None)
        monkeypatch.setitem(sys.modules, "PIL", None)

        assert redact.pillow_available() is False
        assert not redact.write_redacted_image(
            tmp_path / "in.png", [OcrBox("k", 0, 0, 5, 5)], tmp_path / "out.png"
        )
        assert not (tmp_path / "out.png").exists()


# ---------------------------------------------------------------------------
# diagrams in text


class TestC4Readers:
    def test_a_file_that_is_no_workspace_or_holds_no_element_is_none(self):
        assert parse_structurizr("just a note") is None
        assert parse_structurizr("workspace { model { } }") is None

    def test_anonymous_elements_get_a_name_of_their_own(self):
        dsl = (
            "workspace {\n"
            "  model {\n"
            '    person "Customer"\n'
            '    person "Clerk"\n'
            "  }\n"
            "}\n"
        )

        model = parse_structurizr(dsl)

        assert [n.id for n in model.nodes] == ["_person1", "_person2"]

    def test_a_commented_c4_line_is_not_an_element(self):
        text = (
            "@startuml\n!include C4_Container.puml\n"
            '\' Person(ghost, "Ghost")\n'
            'Person(user, "User")\n@enduml\n'
        )

        assert [n.id for n in parse_c4_plantuml(text).nodes] == ["user"]


class TestModels:
    def test_an_unknown_node_is_named_by_its_id(self):
        model = DiagramModel(format="x", nodes=[DiagramNode(id="a", label="")])

        assert model.label_of("a") == "a" and model.label_of("zz") == "zz"

    def test_a_page_count_of_another_type_reads_as_zero(self):
        doc = ExtractedDocument.from_dict(
            {"path": "a.pdf", "pages_total": "many", "pages_read": -3}
        )

        assert (doc.pages_total, doc.pages_read) == (0, 0)


class TestSettings:
    def test_only_the_asked_keys_are_read_from_the_project_file(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.delenv(settings.VISION_MODEL_ENV, raising=False)
        env_file = tmp_path / ".workpilot" / ".env"
        env_file.parent.mkdir()
        env_file.write_text(
            "# a comment\n\nno equals sign\n"
            f'{settings.VISION_MODEL_ENV}="llava:13b"\nJIRA_TOKEN=x\n',
            encoding="utf-8",
        )

        values = settings.project_env(tmp_path)

        assert values.get(settings.VISION_MODEL_ENV) == "llava:13b"
        assert "JIRA_TOKEN" not in values

    @pytest.mark.parametrize("raw", ["", "lots", "-5", "0"])
    def test_a_size_limit_that_is_no_positive_number_is_the_default(self, raw):
        assert settings.max_bytes({settings.MAX_BYTES_ENV: raw}) == (
            settings.DEFAULT_MAX_BYTES
        )


# ---------------------------------------------------------------------------
# CI logs and the card's numbers


class TestDiagnostics:
    def test_nothing_to_read_is_none(self):
        assert diagnostics.read_ci("") is None
        assert diagnostics.diagnose("", None) is None

    def test_a_reader_that_fails_leaves_the_other_s_answer(self, monkeypatch):
        def broken(*_args):
            raise RuntimeError("reader bug")

        monkeypatch.setattr(diagnostics, "analyze", broken)

        found = diagnostics.diagnose("main.go:12:3: undefined: foo\n", None)

        assert found is not None and "stacktrace" not in found
        assert found["ci"]["errors"][0]["file"] == "main.go"

    def test_both_readers_failing_is_no_diagnosis(self, monkeypatch):
        def broken(*_args):
            raise RuntimeError("reader bug")

        monkeypatch.setattr(diagnostics, "analyze", broken)
        monkeypatch.setattr(diagnostics, "read_ci", broken)

        assert diagnostics.diagnose("anything", None) is None

    def test_long_lists_are_cut_and_say_how_many_more(self):
        ci = {
            "errors": [
                {"tool": "tsc", "code": f"TS{i}", "file": "a.ts"} for i in range(3)
            ]
            + ["not an error"],
            "failing_tests": [f"t{i}" for i in range(4)],
        }

        rendered = diagnostics.render_ci(ci, limit=2)

        assert "- TS0 (tsc) `a.ts`" in rendered and "TS2" not in rendered
        assert "- … 1 more" in rendered
        assert "Failing tests:\n- t0\n- t1\n- … 2 more" in rendered

    def test_the_card_counts_errors_codes_and_failing_tests(self):
        summary = diagnostics.summary(
            {
                "ci": {
                    "errors": [{"code": "CS1002"}, {"tool": "go"}, {"code": "CS1002"}],
                    "failing_tests": ["a", "b"],
                }
            }
        )

        assert summary == {
            "ci": {"errors": 3, "codes": ["CS1002", "go"], "failingTests": 2}
        }


class TestC4Edges:
    def test_stray_braces_and_relations_without_ends_are_ignored(self):
        dsl = (
            "workspace {\n"
            "  model {\n"
            '    -> api "orphan relation"\n'
            '    shop = softwareSystem "Shop" {\n'
            '      api = container "API"\n'
            "    }\n"
            '    shop -> ghost "to nothing"\n'
            "  }\n"
            "}\n"
            "}\n"
        )

        model = parse_structurizr(dsl)

        assert [n.id for n in model.nodes] == ["shop", "api"]
        assert model.edges == []

    def test_a_closing_brace_before_any_boundary_is_harmless(self):
        text = '!include C4_Context.puml\n}\nPerson(user, "User")\n'

        assert [n.id for n in parse_c4_plantuml(text).nodes] == ["user"]


class TestRenderingEdges:
    def test_only_failing_tests_are_listed_when_nothing_failed_to_build(self):
        rendered = diagnostics.render_ci({"failing_tests": ["a", "b"]}, limit=5)

        assert rendered == "Failing tests:\n- a\n- b"

    def test_a_spec_without_an_attachments_folder_lists_what_it_names(self, tmp_path):
        spec = tmp_path / "spec"
        (spec / "shots").mkdir(parents=True)
        (spec / "shots" / "a.png").write_bytes(b"a")
        (spec / "requirements.json").write_text(
            json.dumps({"attached_images": [{"path": "shots/a.png"}]}), encoding="utf-8"
        )

        assert [p.name for p in files.attachment_paths(spec)] == ["a.png"]

    def test_a_guarded_path_that_cannot_be_resolved_is_left_out(
        self, spec, monkeypatch
    ):
        _guarded_spec(spec)
        monkeypatch.setattr(read_guard, "_resolved", lambda _path: None)

        assert read_guard.guarded_originals(spec) == {}
