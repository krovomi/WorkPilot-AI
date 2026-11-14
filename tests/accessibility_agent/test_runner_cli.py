"""The accessibility runner, run as the Accessibility view and its fixer run it.

Real pages in a project folder, the real scanner, score, history and fixer.
Only the model asked for alternative texts is a stand-in.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "accessibility_runner.py"
RESULT = "A11Y_RESULT:"
FIX = "A11Y_FIX:"
ERROR = "A11Y_ERROR:"
EVENT = "A11Y_EVENT:"

PAGE = """<html>
<body>
<div class="card"><p>Our team at the office</p><img src="team.png"></div>
<button></button>
</body>
</html>
"""


def _process(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _one(out: str, prefix: str):
    [line] = [x for x in out.splitlines() if x.startswith(prefix)]
    payload = line[len(prefix) :]
    return payload if prefix == ERROR else json.loads(payload)


@pytest.fixture
def site(tmp_path: Path) -> Path:
    root = tmp_path / "site"
    (root / "src").mkdir(parents=True)
    (root / "src" / "index.html").write_text(PAGE, encoding="utf-8")
    return root


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = _process("--project-path", str(tmp_path / "gone"))

    assert done.returncode == 1
    assert _one(done.stdout, ERROR) == (
        f"Project path does not exist: {tmp_path / 'gone'}"
    )


def test_an_empty_project_passes_no_rule(tmp_path: Path) -> None:
    done = _process("--project-path", str(tmp_path))

    assert done.returncode == 0, done.stderr
    result = _one(done.stdout, RESULT)
    assert result["filesScanned"] == 0
    assert result["passedRules"] == []


def test_a_scan_reports_each_page_and_keeps_its_history(site: Path) -> None:
    (site / "src" / "huge.html").write_text(
        "<img src=a.png>" * 80_000, encoding="utf-8"
    )
    outside = site.parent / "outside.html"
    outside.write_text("<img src=b.png>", encoding="utf-8")
    try:
        os.symlink(outside, site / "src" / "linked.html")
    except OSError:
        pass  # no symlink right here: the size bound is still checked

    first = _process("--project-path", str(site), "--target-level", "A")
    second = _process("--project-path", str(site))

    assert first.returncode == 0 and second.returncode == 0, first.stderr
    result = _one(second.stdout, RESULT)
    # The oversized page and the link out of the project are not read.
    assert result["filesScanned"] == 1
    rules = {v["ruleId"] for v in result["violations"]}
    assert {"img-alt", "button-name", "page-lang"} <= rules
    assert {v["file"] for v in result["violations"]} == {"src/index.html"}
    assert result["pagesWithoutLang"] == ["src/index.html"]
    assert result["targetLevel"] == "AA"
    assert "img-alt" not in result["passedRules"] and result["passedRules"]
    assert 0 <= result["score"] < 100
    assert len(result["history"]) == 2
    events = [
        json.loads(x[len(EVENT) :])
        for x in second.stdout.splitlines()
        if x.startswith(EVENT)
    ]
    assert [e["type"] for e in events] == ["start", "progress", "complete"]
    assert events[1]["data"]["status"] == "Scanning 1 files..."


def _fix_ids(site: Path) -> dict[str, str]:
    result = _one(_process("--project-path", str(site)).stdout, RESULT)
    return {v["ruleId"]: v["fixId"] for v in result["violations"] if v["fixId"]}


def test_the_chosen_fixes_are_made_in_the_files(site: Path, tmp_path: Path) -> None:
    ids = _fix_ids(site)
    wanted = tmp_path / "fixes.json"
    wanted.write_text(
        json.dumps([ids["page-lang"], "img-alt:src/gone.html:3:1", 7, "x" * 700]),
        encoding="utf-8",
    )

    done = _process(
        "--project-path", str(site), "--fix", str(wanted), "--page-lang", "fr-CA"
    )

    assert done.returncode == 0, done.stderr
    answer = _one(done.stdout, FIX)
    assert [f["fixId"] for f in answer["applied"]] == [ids["page-lang"]]
    assert answer["missing"] == ["img-alt:src/gone.html:3:1"]
    assert answer["aiAlt"] == 0
    assert '<html lang="fr-CA">' in (site / "src" / "index.html").read_text("utf-8")


def test_a_language_that_is_not_a_tag_declares_english(
    site: Path, tmp_path: Path
) -> None:
    wanted = tmp_path / "fixes.json"
    wanted.write_text(json.dumps([_fix_ids(site)["page-lang"]]), encoding="utf-8")

    done = _process(
        "--project-path", str(site), "--fix", str(wanted), "--page-lang", '" onload="x'
    )

    assert done.returncode == 0, done.stderr
    assert '<html lang="en">' in (site / "src" / "index.html").read_text("utf-8")


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("{not json", "Unreadable fix list: JSONDecodeError"),
        (None, "Unreadable fix list: FileNotFoundError"),
    ],
)
def test_an_unreadable_fix_list_changes_nothing(
    site: Path, tmp_path: Path, content, expected
) -> None:
    wanted = tmp_path / "fixes.json"
    if content is not None:
        wanted.write_text(content, encoding="utf-8")

    done = _process("--project-path", str(site), "--fix", str(wanted))

    assert done.returncode == 1
    assert _one(done.stdout, ERROR) == expected
    assert (site / "src" / "index.html").read_text("utf-8") == PAGE


def test_a_fix_list_that_is_not_a_list_makes_no_fix(site: Path, tmp_path: Path) -> None:
    wanted = tmp_path / "fixes.json"
    wanted.write_text(
        json.dumps({"ids": [_fix_ids(site)["page-lang"]]}), encoding="utf-8"
    )

    done = _process("--project-path", str(site), "--fix", str(wanted))

    assert _one(done.stdout, FIX) == {"applied": [], "missing": [], "aiAlt": 0}
    assert (site / "src" / "index.html").read_text("utf-8") == PAGE


# --- In process: the model for alternative texts, a crash -----------------------------


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("accessibility_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _main(runner, monkeypatch, *args: str) -> int | None:
    monkeypatch.setattr(sys, "argv", ["accessibility_runner.py", *args])
    try:
        runner.main()
    except SystemExit as stop:
        return stop.code
    return None


def test_alternative_texts_come_from_the_model_with_the_page_as_data(
    runner, monkeypatch, site, tmp_path, capsys
) -> None:
    import core.oneshot

    asked: list[str] = []
    img = _fix_ids(site)["img-alt"]

    async def model(prompt, **_options):
        asked.append(prompt)
        return "Here you go: " + json.dumps(
            {img: "  The team   at the office ", "img-alt:src/other.html:1:1": "x"}
        )

    monkeypatch.setattr(core.oneshot, "oneshot_completion", model)
    wanted = tmp_path / "fixes.json"
    wanted.write_text(
        json.dumps(
            [
                img,
                "img-alt:../outside.html:1:1",  # outside the project: not read
                "img-alt:src/missing.html:1:1",  # not a file
                "img-alt:src/index.html:x:1",  # no line number
                "img-alt:src/index.html:4:1",  # the button's line: not an image
            ]
        ),
        encoding="utf-8",
    )

    code = _main(
        runner,
        monkeypatch,
        "--project-path",
        str(site),
        "--fix",
        str(wanted),
        "--ai-alt",
    )

    out = capsys.readouterr().out
    assert code is None
    answer = _one(out, FIX)
    assert answer["aiAlt"] == 1
    assert 'alt="The team at the office"' in (site / "src" / "index.html").read_text(
        "utf-8"
    )
    [prompt] = asked
    # The page reaches the model quoted, as data, with what surrounds the image.
    assert "Our team at the office" in prompt and "team.png" in prompt
    assert "outside.html" not in prompt
    assert "Writing alternative texts..." in out


def test_a_page_that_cannot_be_read_gives_the_model_nothing_from_it(
    runner, monkeypatch, site, tmp_path
) -> None:
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "index.html":
            raise PermissionError("locked")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)

    assert runner._alt_contexts(site, ["img-alt:src/index.html:3:1"]) == []


def test_a_crash_ends_with_the_error_line(runner, monkeypatch, site, capsys) -> None:
    def broken(*_args, **_kwargs):
        raise RuntimeError("scanner broke")

    monkeypatch.setattr(runner.AccessibilityScanner, "scan_files", broken)

    assert _main(runner, monkeypatch, "--project-path", str(site)) == 1
    assert _one(capsys.readouterr().out, ERROR) == "scanner broke"


def test_a_page_that_cannot_be_read_is_left_out_of_the_scan(
    runner, monkeypatch, site
) -> None:
    (site / "src" / "about.html").write_text(
        '<html lang="en"></html>', encoding="utf-8"
    )
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "index.html":
            raise PermissionError("locked")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)

    assert runner._read_sources(site) == {"src/about.html": '<html lang="en"></html>'}
