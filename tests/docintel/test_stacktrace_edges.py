"""Stack traces at their edges, and the repository they are looked up in.

`test_docintel_diagnostics.py` reads one trace per runtime and finds its
frames. This file covers the other spellings — an enumerator's `MoveNext`, a
bare method, a frame with no source, a `file://` URL, a Go frame with no
function above it — and the evidence rules when it runs out: a path that
names nothing, a compiled file whose source is twice there, a class declared
in a file of another name, a file too big or gone, and the ceilings.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from docintel import stacktrace
from docintel.stacktrace import (
    RepoIndex,
    StackFrame,
    StackTrace,
    analyze,
    looks_like_stacktrace,
    parse_frame,
    parse_stacktrace,
    render_stacktrace,
    resolve,
    resolve_file,
    short_symbol,
    split_dotnet,
    split_java,
)


def write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestSymbols:
    def test_an_enumerator_that_is_no_state_machine_keeps_its_names(self):
        assert split_dotnet("Acme.Pager.MoveNext") == ("Pager", "MoveNext", [])

    def test_a_bare_method_has_no_type(self):
        assert split_dotnet("Main") == ("", "Main", [])
        assert split_java("create") == ("", "create", [])

    def test_a_constructor_is_named_after_its_type(self):
        frame = parse_frame("\tat com.acme.Order.<init>(Order.java:3)")

        assert short_symbol(frame) == "Order"

    def test_a_record_survives_its_frames_that_cannot_be_read_back(self):
        trace = StackTrace.from_dict(
            {
                "language": "python",
                "frames": [
                    "not a frame",
                    {"symbol": "no language"},
                    {"language": "go"},
                ],
            }
        )

        assert [f.language for f in trace.frames] == ["go"]


class TestFrames:
    def test_a_jvm_frame_without_its_source_has_no_file(self):
        frame = parse_frame("\tat com.acme.Order.create(Unknown Source)")

        assert (frame.file, frame.line, frame.method) == ("", None, "create")

    def test_a_python_module_level_frame_has_no_method(self):
        frame = parse_frame('  File "/app/run.py", line 3, in <module>')

        assert (frame.symbol, frame.method) == ("<module>", "")

    def test_a_dotnet_call_without_a_type_or_file_is_no_frame(self):
        assert parse_frame("   at Main()") is None

    def test_a_php_function_has_no_type(self):
        frame = parse_frame("#1 /var/www/index.php(3): bootstrap()")

        assert (frame.symbol, frame.type_name, frame.method) == ("bootstrap", "", "")

    def test_a_file_url_is_read_as_its_path(self):
        frame = parse_frame("    at load (file:///app/src/loader.mjs:4:2)")

        assert frame.file == "/app/src/loader.mjs"
        assert (frame.type_name, frame.method) == ("", "load")

    def test_an_anonymous_member_has_no_method(self):
        frame = parse_frame("    at Router.<anonymous> (/app/routes/orders.js:9:1)")

        assert (frame.type_name, frame.method) == ("Router", "")

    def test_a_go_frame_with_no_function_above_it(self):
        trace = parse_stacktrace("\t/app/server.go:42 +0x1d\n\t/app/main.go:7\n")

        assert [(f.file, f.symbol) for f in trace.frames] == [
            ("/app/server.go", ""),
            ("/app/main.go", ""),
        ]

    def test_the_frames_stop_at_their_ceiling(self, monkeypatch):
        monkeypatch.setattr(stacktrace, "MAX_FRAMES", 2)
        text = "".join(f"    at f{n} (/app/a.js:{n}:1)\n" for n in range(1, 6))

        assert len(parse_stacktrace(text).frames) == 2
        assert looks_like_stacktrace(text)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    write(
        tmp_path,
        "src/Billing/InvoiceMailer.cs",
        "class InvoiceMailer { void Send() {} }\n",
    )
    write(tmp_path, "src/a/orders.ts", "export function list() {}\n")
    write(tmp_path, "src/b/orders.ts", "export function list() {}\n")
    write(tmp_path, "web/src/carts.ts", "export function add() {}\n")
    write(
        tmp_path,
        "src/Shop/Handlers.cs",
        "public class OrderHandler\n{\n    // Handle is called below\n    Handle\n}\n",
    )
    return tmp_path


def resolved(root: Path, *lines: str, index: RepoIndex | None = None) -> StackTrace:
    return resolve(
        parse_stacktrace("Unhandled exception.\n" + "\n".join(lines)), root, index
    )


class TestTheRepository:
    def test_a_unique_file_name_that_names_the_method_is_kept(self, repo):
        frame = StackFrame("dotnet", file="C:\\build\\InvoiceMailer.cs", method="Send")

        assert resolve_file(frame, RepoIndex(repo)) == (
            "src/Billing/InvoiceMailer.cs",
            "path",
        )

    def test_a_path_that_names_no_file_is_not_looked_up(self, repo):
        assert resolve_file(StackFrame("node", file="./"), RepoIndex(repo)) == ("", "")

    def test_compiled_frames_outside_a_build_or_with_two_sources(self, repo):
        trace = resolved(
            repo,
            "    at list (/srv/app/orders.js:3:1)",
            "    at list (/srv/dist/orders.js:3:1)",
            "    at add (/srv/dist/other/carts.js:3:1)",
        )

        assert [(f.match, f.origin) for f in trace.frames] == [
            ("", "unknown"),
            ("ambiguous", "unknown"),
            ("", "unknown"),
        ]

    def test_a_class_declared_in_a_file_of_another_name(self, repo):
        trace = resolved(
            repo, "   at Shop.OrderHandler.Handle()", "   at Shop.Program.Main()"
        )

        frame = trace.frames[0]
        assert (frame.path, frame.match, frame.line) == (
            "src/Shop/Handlers.cs",
            "symbol",
            None,
        )

    def test_a_frame_of_a_language_looked_up_by_path_only(self, repo):
        trace = resolved(
            repo, '  File "x", line 1, in run', '  File "y", line 2, in go'
        )

        assert all(f.origin == "unknown" for f in trace.frames)

    def test_a_file_too_big_to_read_keeps_the_traces_line(self, repo, monkeypatch):
        monkeypatch.setattr(stacktrace, "MAX_SCAN_BYTES", 8)

        trace = resolved(
            repo,
            "   at Billing.InvoiceMailer.Send() in /b/src/Billing/InvoiceMailer.cs:line 99",
            "   at X.Y()",
        )

        frame = trace.frames[0]
        assert (frame.line, frame.stale_line) == (99, False)

    def test_a_file_gone_since_the_index_reads_as_nothing(self, repo):
        index = RepoIndex(repo)
        index.by_name  # noqa: B018 - built before the file goes
        (repo / "web" / "src" / "carts.ts").unlink()

        assert index.text("web/src/carts.ts") is None

    def test_the_index_skips_links_and_stops_at_its_ceilings(self, repo, monkeypatch):
        write(repo, "deep/a/b/c.cs", "")
        try:
            (repo / "link.cs").symlink_to(repo / "src" / "Billing" / "InvoiceMailer.cs")
        except OSError:  # Windows without the right to make one
            pass
        monkeypatch.setattr(stacktrace, "MAX_INDEX_DEPTH", 1)

        names = RepoIndex(repo).by_name

        assert "link.cs" not in names and "c.cs" not in names
        write(repo, "README.md", "")
        monkeypatch.setattr(stacktrace, "MAX_INDEX_DEPTH", 14)
        monkeypatch.setattr(stacktrace, "MAX_INDEX_FILES", 1)
        assert list(RepoIndex(repo).by_name) == ["readme.md"]

    def test_a_trace_nobody_could_read_is_none(self, monkeypatch):
        def broken(_text):
            raise ValueError("unreadable")

        monkeypatch.setattr(stacktrace, "parse_stacktrace", broken)

        assert analyze("anything", None) is None

    def test_no_line_without_a_method_or_a_text(self):
        assert stacktrace._line_of(None, "Send") is None
        assert stacktrace._line_of("Send()", "") is None


class TestRendering:
    def test_more_project_frames_than_shown_are_counted(self, repo, monkeypatch):
        monkeypatch.setattr(stacktrace, "MAX_RENDERED_FRAMES", 1)
        line = "   at Billing.InvoiceMailer.Send() in /b/src/Billing/InvoiceMailer.cs:line 1"

        text = render_stacktrace(resolved(repo, line, line))

        assert "… 1 more project frame(s)" in text
