"""Contrast as WCAG computes it, the score, and fixes made only where they are asked (#391)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from accessibility_agent import AccessibilityScanner, WcagLevel
from accessibility_agent.contrast import (
    Tokens,
    contrast_ratio,
    load_tokens,
    pairs_in_css,
    parse_color,
    required_ratio,
)
from accessibility_agent.fixer import apply_fixes
from accessibility_agent.generated import check_generated
from accessibility_agent.score import append_history, breakdown, read_history, score

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "accessibility_runner.py"
)


class TestContrast:
    @pytest.mark.parametrize(
        ("fg", "bg", "ratio"),
        [
            ("#000", "#fff", 21.0),
            ("#777", "#fff", 4.48),
            ("#767676", "#ffffff", 4.54),
            ("white", "white", 1.0),
        ],
    )
    def test_the_ratio_of_the_standard(self, fg, bg, ratio):
        assert contrast_ratio(parse_color(fg), parse_color(bg)) == ratio

    @pytest.mark.parametrize(
        "value",
        [
            "#abc",
            "#aabbcc",
            "#aabbccff",
            "rgb(10, 20, 30)",
            "rgba(10 20 30 / 50%)",
            "hsl(200, 50%, 40%)",
            "navy",
        ],
    )
    def test_every_plain_colour_syntax(self, value):
        assert parse_color(value) is not None

    @pytest.mark.parametrize(
        "value",
        ["currentColor", "linear-gradient(red, blue)", "var(--x)", "inherit", "#ggg"],
    )
    def test_what_is_not_a_plain_colour_is_never_guessed(self, value):
        assert parse_color(value) is None

    def test_a_see_through_background_is_unknown(self):
        assert (
            contrast_ratio(parse_color("#000"), parse_color("rgba(255,255,255,0.5)"))
            is None
        )

    def test_large_text_needs_less(self):
        assert required_ratio("AA", large=True) == 3.0
        assert required_ratio("AAA", large=False) == 7.0
        css = ".h { color: #888; background: #fff; font-size: 32px }"
        assert pairs_in_css(css, Tokens())[0].large

    def test_variables_of_css_scss_and_less_resolve(self):
        css = ":root { --fg: #999; }\n$bg: #fff;\n.a { color: var(--fg); background-color: $bg; }"
        (pair,) = pairs_in_css(css, Tokens())
        assert pair.ratio < 4.5 and pair.line == 3

    def test_a_var_fallback_is_used_when_the_variable_is_unknown(self):
        (pair,) = pairs_in_css(
            ".a { color: var(--missing, #000); background: #fff }", Tokens()
        )
        assert pair.ratio == 21.0

    def test_the_token_map_resolves_design_system_classes(self, tmp_path):
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / ".workpilot" / "a11y-tokens.json").write_text(
            json.dumps(
                {
                    "tokens": {
                        "text-muted": "#aaaaaa",
                        "bg-card": "#ffffff",
                        "bad": "nope",
                    }
                }
            )
        )
        tokens = load_tokens(tmp_path)
        assert "bad" not in tokens.mapping
        scanner = AccessibilityScanner(tokens=tokens)
        violations = scanner.scan_file(
            "A.tsx", 'return <p className="text-muted bg-card">x</p>;'
        ).violations
        assert [v.rule_id for v in violations] == ["color-contrast"]
        # A hover or dark-mode class is another state than the one shown.
        assert not scanner.scan_file(
            "A.tsx", 'return <p className="hover:text-muted bg-card">x</p>;'
        ).violations

    def test_a_broken_or_linked_token_map_maps_nothing(self, tmp_path):
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / ".workpilot" / "a11y-tokens.json").write_text("{not json")
        assert load_tokens(tmp_path).mapping == {}


class TestScore:
    def test_one_critical_in_ten_files_scores_91(self):
        assert score([{"severity": "critical"}], 10) == 91
        assert score([], 3) == 100

    def test_the_breakdown_puts_the_worst_criterion_first(self):
        rows = breakdown(
            [
                {"severity": "minor", "wcagCriteria": "2.4.3", "wcagLevel": "A"},
                {"severity": "critical", "wcagCriteria": "1.1.1", "wcagLevel": "A"},
            ],
            1,
        )
        assert [r["criterion"] for r in rows] == ["1.1.1", "2.4.3"]
        assert rows[0]["name"] == "Non-text content"

    def test_history_is_appended_and_capped(self, tmp_path):
        report = {"score": 80, "targetLevel": "AA", "violations": [], "filesScanned": 2}
        for _ in range(3):
            append_history(tmp_path, report)
        history = read_history(tmp_path)
        assert len(history) == 3 and history[-1]["score"] == 80

    def test_history_is_not_written_through_a_link(self, tmp_path):
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        project = tmp_path / "p"
        project.mkdir()
        try:
            (project / ".workpilot").symlink_to(elsewhere, target_is_directory=True)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks need privileges on this platform")
        append_history(
            project,
            {"score": 1, "targetLevel": "AA", "violations": [], "filesScanned": 1},
        )
        assert not any(elsewhere.rglob("*.jsonl"))


def _project(tmp_path: Path) -> Path:
    src = tmp_path / "src"
    src.mkdir()
    (src / "App.tsx").write_text(
        'import { Trash2 } from "lucide-react";\n'
        "export const App = () => (\n"
        "  <main>\n"
        '    <img src="/hero-banner@2x.png" />\n'
        '    <input placeholder="Email" />\n'
        "    <button onClick={remove}><Trash2 /></button>\n"
        '    <img src="/a.png" />\n'
        "  </main>\n"
        ");\n"
    )
    (src / "index.html").write_text(
        "<html><head><title>x</title></head><body></body></html>"
    )
    return tmp_path


class TestFixes:
    def test_each_fix_is_derived_from_the_source(self, tmp_path):
        root = _project(tmp_path)
        report = AccessibilityScanner().scan_file(
            "src/App.tsx", (root / "src" / "App.tsx").read_text()
        )
        fixes = {v.rule_id: v.fix for v in report.violations if v.fix}
        assert fixes["control-label"] == {"attribute": "aria-label", "value": "Email"}
        assert fixes["button-name"] == {"attribute": "aria-label", "value": "Trash"}
        alts = sorted(
            v.fix["value"]
            for v in report.violations
            if v.rule_id == "img-alt" and v.fix
        )
        # "/a.png" says nothing: no fix is invented for it.
        assert alts == ["Hero banner"]

    def test_only_the_asked_fixes_are_made(self, tmp_path):
        root = _project(tmp_path)
        app = root / "src" / "App.tsx"
        report = AccessibilityScanner().scan_file("src/App.tsx", app.read_text())
        wanted = {
            v.fix_id
            for v in report.violations
            if v.rule_id in ("img-alt", "control-label") and v.fix_id
        }
        applied, missing = apply_fixes(root, wanted)
        text = app.read_text()
        assert {f.rule_id for f in applied} == {
            "img-alt",
            "control-label",
        } and not missing
        assert '<img alt="Hero banner" src="/hero-banner@2x.png" />' in text
        assert '<input aria-label="Email" placeholder="Email" />' in text
        assert "<button onClick" in text  # not asked: untouched

    def test_a_fix_for_code_that_changed_is_reported_missing(self, tmp_path):
        root = _project(tmp_path)
        report = AccessibilityScanner().scan_file(
            "src/App.tsx", (root / "src" / "App.tsx").read_text()
        )
        wanted = {v.fix_id for v in report.violations if v.fix_id}
        (root / "src" / "App.tsx").write_text("export const App = () => null;\n")
        applied, missing = apply_fixes(root, wanted)
        assert not applied and sorted(missing) == sorted(wanted)

    def test_a_fix_never_reaches_outside_the_root(self, tmp_path):
        outside = tmp_path / "outside.html"
        outside.write_text("<html></html>")
        root = tmp_path / "root"
        root.mkdir()
        applied, _ = apply_fixes(root, {"page-lang:../outside.html:1:1"}, lang="fr")
        assert not applied and outside.read_text() == "<html></html>"


class TestRunner:
    def _run(self, *args: str) -> list[str]:
        out = subprocess.run(
            [sys.executable, str(RUNNER), *args],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert out.returncode == 0, out.stdout + out.stderr
        return out.stdout.splitlines()

    def test_the_report_has_the_score_breakdown_history_and_passed_rules(
        self, tmp_path
    ):
        root = _project(tmp_path)
        lines = self._run("--project-path", str(root))
        report = json.loads(
            next(line for line in lines if line.startswith("A11Y_RESULT:"))[12:]
        )
        assert 0 < report["score"] < 100
        assert report["criteria"] and report["pages"][0]["file"] == "src/App.tsx"
        assert report["pagesWithoutLang"] == ["src/index.html"]
        assert (
            "page-title" in report["passedRules"]
            and "img-alt" not in report["passedRules"]
        )
        assert len(report["history"]) == 1

    def test_fix_mode_makes_the_listed_fixes(self, tmp_path):
        root = _project(tmp_path)
        lines = self._run("--project-path", str(root))
        report = json.loads(
            next(line for line in lines if line.startswith("A11Y_RESULT:"))[12:]
        )
        ids = [v["fixId"] for v in report["violations"] if v["ruleId"] == "page-lang"]
        listed = tmp_path / "fixes.json"
        listed.write_text(json.dumps(ids))
        lines = self._run(
            "--project-path", str(root), "--fix", str(listed), "--page-lang", "fr"
        )
        outcome = json.loads(
            next(line for line in lines if line.startswith("A11Y_FIX:"))[9:]
        )
        assert [f["value"] for f in outcome["applied"]] == ["fr"]
        assert '<html lang="fr">' in (root / "src" / "index.html").read_text()

    def test_a_hostile_page_lang_falls_back_to_en(self, tmp_path):
        root = _project(tmp_path)
        lines = self._run("--project-path", str(root))
        report = json.loads(
            next(line for line in lines if line.startswith("A11Y_RESULT:"))[12:]
        )
        ids = [v["fixId"] for v in report["violations"] if v["ruleId"] == "page-lang"]
        listed = tmp_path / "fixes.json"
        listed.write_text(json.dumps(ids))
        self._run(
            "--project-path",
            str(root),
            "--fix",
            str(listed),
            "--page-lang",
            'x" onload="alert(1)',
        )
        assert '<html lang="en">' in (root / "src" / "index.html").read_text()


def test_generated_code_is_scored_before_it_is_written():
    checked = check_generated(
        {"src/Hero.vue": '<template><img src="x.png"></template>', "README.md": "# x"}
    )
    assert checked["count"] == 1 and checked["violations"][0]["ruleId"] == "img-alt"
    assert check_generated({"main.py": "print(1)"}) is None


def test_the_design_to_code_result_carries_its_accessibility():
    from services.design_to_code_service import (
        GeneratedFile,
        PipelineResult,
        serialize_result,
    )

    result = PipelineResult(
        generated_files=[
            GeneratedFile("Hero.tsx", "return <img src='x.png' />;", "tsx")
        ]
    )
    assert serialize_result(result)["accessibility"]["count"] == 1
