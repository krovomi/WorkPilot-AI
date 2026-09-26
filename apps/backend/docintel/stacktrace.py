"""A stack trace — screenshotted, pasted or logged — read down to file and line.

A person attaching a crash to a task attaches the one thing that says where the
code broke. Handed over as text, an agent re-derives it: greps for the method
name, opens the wrong `Program.cs`, and reads fifty framework frames before the
one that belongs to the project. The trace already names the frame; the
repository already has the file. Joining the two is lookup, not judgement, so it
happens here, without a model.

| Language | Frame as printed |
|---|---|
| .NET | `at Ns.Class.Method(args) in /src/File.cs:line 42` (also `à … dans …:ligne 42`) |
| Python | `File "/app/orders/service.py", line 42, in create` |
| Node | `at OrdersService.create (/app/dist/orders/service.js:42:13)` |
| Java, Kotlin, Scala | `at com.acme.orders.OrderService.create(OrderService.java:42)` |
| Go | `main.(*Server).handle(…)` then `\t/app/server.go:42 +0x1d` |
| Ruby | `app/models/order.rb:42:in 'create'` |
| PHP | `#0 /var/www/src/Order.php(42): App\\Order->create()` |
| Rust | `at ./src/orders.rs:42:9` |

**A frame is attached to a file only on evidence.** By the longest run of path
segments the trace and the repository share; a bare file name counts only when
it is unique *and* not a name every project has (`index.js`, `Program.cs`,
`__init__.py`), and then only when the method it names is in that file. With no
path at all — a .NET release build without PDBs, a Java `Unknown Source` — the
class and method are looked up among the language's sources, and only a single
file declaring the one and containing the other is kept. Two candidates are
*ambiguous*, never a guess: an agent sent to the wrong file costs more than an
agent told to look.

**The project first, the framework folded.** `System.*`, `Microsoft.*`,
`node_modules`, `site-packages`, `java.*`, the Go runtime: counted, not listed.
What is left is the handful of frames somebody on this project wrote.

**Nothing here is a string from the trace passed on as prose.** Paths are the
repository's own, symbols are matched by character classes that admit no
sentence, and the exception message stays in the fenced attachment text it came
from.
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

#: Directories never indexed: build output, vendored trees, caches.
SKIP_DIRS = {
    ".git",
    ".workpilot",
    "node_modules",
    "bin",
    "obj",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".vs",
    ".idea",
    "packages",
    "vendor",
    "TestResults",
    "coverage",
    "site-packages",
}
MAX_INDEX_FILES = 60000
MAX_INDEX_DEPTH = 14
MAX_FRAMES = 200
MAX_SCAN_FILES = 4000
MAX_SCAN_BYTES = 1024 * 1024

#: Names too common for a lone file name to identify a file.
GENERIC_STEMS = {
    "index",
    "main",
    "app",
    "server",
    "program",
    "startup",
    "__init__",
    "__main__",
    "mod",
    "lib",
    "utils",
    "util",
    "helpers",
    "handler",
    "handlers",
    "views",
    "models",
    "routes",
    "service",
    "services",
    "controller",
    "base",
    "common",
    "config",
    "settings",
}

#: Source extensions a symbol-only frame is looked up in, per language.
LANGUAGE_EXTENSIONS = {
    "dotnet": (".cs", ".vb", ".fs"),
    "java": (".java", ".kt", ".scala", ".groovy"),
}

_FRAMEWORK_SYMBOLS = re.compile(
    r"^(?:System|Microsoft|Windows|Newtonsoft|Npgsql|MySqlConnector|Swashbuckle|"
    r"MediatR|AutoMapper|Serilog|Polly|Grpc|Google|Castle|NHibernate|Dapper|Xunit|"
    r"NUnit|Moq|java|javax|jakarta|jdk|sun|com\.sun|kotlin|kotlinx|scala|"
    r"org\.springframework|org\.apache|org\.hibernate|org\.junit|org\.eclipse|"
    r"io\.netty|reactor|runtime|net/http|internal)[.$/]|^lambda_method\d*$"
)
_FRAMEWORK_PATHS = re.compile(
    r"(?:^|[/\\])(?:node_modules|site-packages|dist-packages|gems|vendor|\.cargo|"
    r"rustc|go[/\\]src[/\\]runtime|go[/\\]pkg[/\\]mod|lib[/\\]python[\d.]*)"
    r"(?:[/\\]|$)|^node:|^internal[/\\]|^<frozen|^\[native|^<anonymous>",
    re.IGNORECASE,
)

# --- Frame patterns ---------------------------------------------------------
# Every symbol group is a character class without spaces: a "frame" that is a
# sentence is not a frame, and nothing a trace carries reaches a prompt as prose.


_JAVA = re.compile(
    r"^\s*at\s+(?:[\w.$-]+/)?(?P<symbol>[\w.$<>]+)\("
    r"(?P<file>[\w$.-]+\.(?:java|kt|kts|scala|groovy)):(?P<line>\d+)\)\s*$"
    r"|^\s*at\s+(?:[\w.$-]+/)?(?P<symbol2>[\w.$<>]+)\((?:Unknown Source|Native Method)\)\s*$"
)
_NODE = re.compile(
    r"^\s*at\s+(?:async\s+)?(?:(?P<symbol>(?:new\s+)?[\w.$<>\[\]]+(?:\s+\[as\s+[\w$]+\])?)\s+\()?"
    r"(?P<file>(?:file://)?[^\s()]+?):(?P<line>\d+)(?::\d+)?\)?\s*$"
)
_DOTNET = re.compile(
    r"^\s*(?:at|à|bei|en|a|в)\s+(?P<symbol>[\w.`<>|+\[\],$-]+)\((?P<args>[^)]*)\)"
    r"(?:\s+(?:in|dans|in|en|в)\s+(?P<file>.+?):\s*(?:line|ligne|Zeile|línea|riga|строка)"
    r"\s*(?P<line>\d+))?\s*$"
)
_PYTHON = re.compile(
    r'^\s*File\s+"(?P<file>[^"]+)",\s+line\s+(?P<line>\d+)(?:,\s+in\s+(?P<symbol>[\w.<>]+))?'
)
_GO_FILE = re.compile(r"^\s+(?P<file>\S+\.go):(?P<line>\d+)(?:\s+\+0x[0-9a-f]+)?\s*$")
_GO_FUNC = re.compile(r"^(?P<symbol>[\w./*()%-]+)\(.*\)\s*$")
_RUBY = re.compile(
    r"^\s*(?:from\s+)?(?P<file>[^\s:]+\.rb):(?P<line>\d+):in\s+[`'](?P<symbol>[^'`\s]+(?: in [^'`\s]+)?)'"
)
_PHP = re.compile(
    r"^\s*#\d+\s+(?P<file>[^\s(]+\.php)\((?P<line>\d+)\):\s*(?P<symbol>[\w\\:>$-]+)"
)

_EXCEPTION = re.compile(
    r"^\s*(?:Unhandled exception\.\s*|Unhandled Exception:\s*|Exception non gérée\s*:?\s*|"
    r"Exception in thread \"[^\"]*\"\s+|Caused by:\s+|Uncaught\s+|Error:\s+(?=\w+Exception))?"
    r"(?P<type>(?:[\w$]+\.)*(?:[A-Z][\w$]*)?(?:Exception|Error|Exit|Interrupt|Fault|Panic))"
    r"(?:\s*:|\s*$)"
)
_PANIC = re.compile(r"^\s*(?:panic:|thread '[^']*' panicked at)")


@dataclass
class StackFrame:
    """One frame, as printed and as found in the repository."""

    language: str
    #: The symbol the trace printed, normalised (`OrdersController.Create`).
    symbol: str = ""
    #: The type and method it names, compiler artefacts removed.
    type_name: str = ""
    method: str = ""
    #: The file as the trace printed it (another machine's path).
    file: str = ""
    line: int | None = None
    #: Where it is in *this* repository, relative to its root; "" when not found.
    path: str = ""
    #: ``path`` (segments shared with the trace), ``symbol`` (class and method
    #: found), ``compiled`` (a `.js` in `dist/` whose `.ts` source is unique),
    #: ``ambiguous`` (several candidates, none chosen) or "".
    match: str = ""
    #: ``project``, ``framework`` or ``unknown`` (named nothing found here).
    origin: str = "unknown"
    #: The trace's line is past the end of the file: another version of it.
    stale_line: bool = False


@dataclass
class StackTrace:
    language: str = ""
    #: The exception type, when the trace printed one (`System.NullReferenceException`).
    exception: str = ""
    #: Innermost frame first, whatever order the runtime printed them in.
    frames: list[StackFrame] = field(default_factory=list)

    @property
    def project_frames(self) -> list[StackFrame]:
        return [f for f in self.frames if f.origin == "project"]

    @property
    def framework_count(self) -> int:
        return sum(1 for f in self.frames if f.origin == "framework")

    @property
    def unknown_frames(self) -> list[StackFrame]:
        return [f for f in self.frames if f.origin == "unknown"]

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "exception": self.exception,
            "frames": [asdict(f) for f in self.frames],
            "project_frames": len(self.project_frames),
            "framework_frames": self.framework_count,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> StackTrace:
        frames = []
        for raw in payload.get("frames") or []:
            if not isinstance(raw, dict):
                continue
            known = {k: raw[k] for k in StackFrame.__dataclass_fields__ if k in raw}
            try:
                frames.append(StackFrame(**known))
            except TypeError:
                continue
        return cls(
            language=str(payload.get("language", "")),
            exception=str(payload.get("exception", "")),
            frames=frames,
        )


# ---------------------------------------------------------------------------
# Symbols: compiler artefacts back to what somebody wrote
# ---------------------------------------------------------------------------

_DOTNET_STATE_MACHINE = re.compile(r"^<(?P<name>[\w]+)>[a-z]__[\w|]+$")
_GENERIC_ARITY = re.compile(r"`\d+|\[[^\]]*\]$")


def split_dotnet(symbol: str) -> tuple[str, str, list[str]]:
    """(type, method, outer types) for a .NET frame symbol.

    `Ns.OrdersController.<Create>d__5.MoveNext` is `OrdersController.Create`:
    the async state machine is the compiler's, the method is the author's.
    Lambdas (`<>c.<Create>b__1_0`, `<>c__DisplayClass3_0`), local functions
    (`<Create>g__Local|2_0`), generics (`` Repo`1 ``) and nested types
    (`Outer+Inner`) get the same treatment.
    """
    symbol = symbol.replace("..ctor", ".#ctor").replace("..cctor", ".#cctor")
    parts = [p for p in symbol.split(".") if p]
    method = parts.pop() if parts else ""
    if method in ("MoveNext", "SetResult") and parts:
        state = _DOTNET_STATE_MACHINE.match(parts[-1])
        if state:
            parts.pop()
            method = state.group("name")
    elif state := _DOTNET_STATE_MACHINE.match(method):
        method = state.group("name")
    # Compiler-generated closure classes sit between the type and the method.
    while parts and parts[-1].startswith("<>"):
        parts.pop()
    method = _GENERIC_ARITY.sub("", method)
    if method in ("#ctor", "#cctor"):
        method = ""
    type_path = _GENERIC_ARITY.sub("", parts[-1]) if parts else ""
    nested = [t for t in type_path.split("+") if t and not t.startswith("<")]
    if not nested:
        return "", method, []
    return nested[-1], method or nested[-1], nested[:-1]


def split_java(symbol: str) -> tuple[str, str, list[str]]:
    """(type, method, outer types) for a JVM frame: `lambda$create$0` is `create`,
    `OrderService$Inner` is `Inner` inside `OrderService`, `<init>` the type."""
    head, _, method = symbol.rpartition(".")
    lam = re.match(r"^lambda\$(\w+?)\$\d+$", method)
    if lam:
        method = lam.group(1)
    type_path = head.rpartition(".")[2]
    nested = [t for t in type_path.split("$") if t and not t.isdigit()]
    if not nested:
        return "", method, []
    if method in ("<init>", "<clinit>"):
        method = nested[-1]
    return nested[-1], method, nested[:-1]


def _split_dotted(symbol: str) -> tuple[str, str]:
    """`OrdersService.create` -> (`OrdersService`, `create`); `create` -> ("", `create`)."""
    symbol = re.sub(r"\s*\[as\s+[\w$]+\]$", "", symbol.replace("new ", "")).strip()
    head, _, method = symbol.rpartition(".")
    type_name = head.rpartition(".")[2] if head else ""
    if type_name in ("Object", "Module", "<anonymous>", "process", "Promise"):
        type_name = ""
    if method.startswith("<"):
        method = ""
    return type_name, method


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _frame_for_file_line(language: str, file: str, line: str | None) -> StackFrame:
    return StackFrame(
        language=language, file=file.strip(), line=int(line) if line else None
    )


def _language_of(file: str) -> str:
    suffix = Path(file.split("?")[0]).suffix.lower()
    return {
        ".rs": "rust",
        ".go": "go",
        ".py": "python",
        ".rb": "ruby",
        ".php": "php",
        ".java": "java",
        ".kt": "java",
        ".cs": "dotnet",
    }.get(suffix, "node")


def parse_frame(line: str) -> StackFrame | None:
    """One line of a trace as a frame, or None. Never raises."""
    if len(line) > 2000:
        return None
    if m := _JAVA.match(line):
        symbol = m.group("symbol") or m.group("symbol2") or ""
        type_name, method, _outer = split_java(symbol)
        frame = StackFrame(
            language="java", symbol=symbol, type_name=type_name, method=method
        )
        if m.group("file"):
            package = symbol.rsplit(".", 2)[0] if symbol.count(".") >= 2 else ""
            # `com.acme.orders` + `OrderService.java` is a path the repository
            # can be searched for: the package *is* the directory in Java.
            frame.file = (
                package.replace(".", "/") + "/" + m.group("file")
                if package and m.group("file").endswith(".java")
                else m.group("file")
            )
            frame.line = int(m.group("line"))
        return frame
    if m := _PYTHON.match(line):
        frame = _frame_for_file_line("python", m.group("file"), m.group("line"))
        frame.symbol = frame.method = m.group("symbol") or ""
        if frame.method == "<module>":
            frame.method = ""
        return frame
    if m := _DOTNET.match(line):
        symbol = m.group("symbol")
        if "." in symbol or m.group("file"):
            type_name, method, _outer = split_dotnet(symbol)
            frame = StackFrame(
                language="dotnet", symbol=symbol, type_name=type_name, method=method
            )
            if m.group("file"):
                frame.file = m.group("file").strip()
                frame.line = int(m.group("line"))
            return frame
    if m := _RUBY.match(line):
        frame = _frame_for_file_line("ruby", m.group("file"), m.group("line"))
        frame.symbol = m.group("symbol")
        frame.method = frame.symbol.rpartition(" in ")[2]
        return frame
    if m := _PHP.match(line):
        frame = _frame_for_file_line("php", m.group("file"), m.group("line"))
        frame.symbol = m.group("symbol")
        parts = re.split(r"->|::", frame.symbol)
        if len(parts) >= 2:
            frame.type_name = parts[-2].rpartition("\\")[2]
            frame.method = parts[-1]
        return frame
    if m := _NODE.match(line):
        file = m.group("file")
        if file.startswith("file://"):
            file = file[len("file://") :]
        language = _language_of(file)
        frame = _frame_for_file_line(language, file, m.group("line"))
        symbol = (m.group("symbol") or "").strip()
        if symbol:
            frame.symbol = symbol
            frame.type_name, frame.method = _split_dotted(symbol)
        return frame
    return None


def parse_stacktrace(text: str) -> StackTrace | None:
    """Every frame in `text`, innermost first, or None when it is not a trace.

    A trace is at least two frames, or one frame under an exception header —
    a single `at x (y:1)` in a paragraph is a sentence about code, not a crash.
    """
    if not text:
        return None
    lines = text.splitlines()
    frames: list[StackFrame] = []
    exception = ""
    python_order = False
    panic = False
    for index, raw in enumerate(lines[:5000]):
        if not exception and (m := _EXCEPTION.match(raw)):
            exception = m.group("type")
        if _PANIC.match(raw):
            panic = True
        if raw.strip().startswith("Traceback (most recent call last)"):
            python_order = True
        if m := _GO_FILE.match(raw):
            frame = _frame_for_file_line("go", m.group("file"), m.group("line"))
            previous = lines[index - 1].strip() if index else ""
            if fn := _GO_FUNC.match(previous):
                frame.symbol = fn.group("symbol")
                tail = frame.symbol.rpartition("/")[2]
                frame.type_name, frame.method = _split_dotted(
                    tail.replace("(*", "").replace(")", "")
                )
            frames.append(frame)
        elif frame := parse_frame(raw):
            frames.append(frame)
        if len(frames) >= MAX_FRAMES:
            break

    if not frames or (len(frames) < 2 and not exception and not panic):
        return None
    if python_order or all(f.language == "python" for f in frames):
        # "most recent call last": turned around so every language reads the
        # same way — the frame that threw first.
        frames.reverse()
    languages = [f.language for f in frames]
    language = max(set(languages), key=languages.count)
    return StackTrace(language=language, exception=exception, frames=frames)


def looks_like_stacktrace(text: str) -> bool:
    return parse_stacktrace(text) is not None


# ---------------------------------------------------------------------------
# The repository side
# ---------------------------------------------------------------------------


def _segments(path: str) -> list[str]:
    parts = re.split(r"[/\\]+", path.strip())
    return [
        p
        for p in parts
        if p and p not in (".", "..") and not re.fullmatch(r"[A-Za-z]:", p)
    ]


class RepoIndex:
    """The repository's files by lower-cased name, built once, on first use."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._by_name: dict[str, list[str]] | None = None
        self._texts: dict[str, str | None] = {}

    @property
    def by_name(self) -> dict[str, list[str]]:
        if self._by_name is None:
            self._by_name = {}
            count = 0
            root_depth = len(self.root.parts)
            for current, dirs, files in os.walk(self.root):
                base = Path(current)
                if len(base.parts) - root_depth >= MAX_INDEX_DEPTH:
                    dirs[:] = []
                dirs[:] = sorted(
                    d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")
                )
                for name in files:
                    candidate = base / name
                    if candidate.is_symlink():
                        continue
                    relative = candidate.relative_to(self.root).as_posix()
                    self._by_name.setdefault(name.lower(), []).append(relative)
                    count += 1
                if count >= MAX_INDEX_FILES:
                    break
        return self._by_name

    def text(self, relative: str) -> str | None:
        if relative not in self._texts:
            path = self.root / relative
            try:
                if path.stat().st_size > MAX_SCAN_BYTES:
                    self._texts[relative] = None
                else:
                    self._texts[relative] = path.read_text(
                        encoding="utf-8", errors="replace"
                    )
            except OSError:
                self._texts[relative] = None
        return self._texts[relative]

    def with_suffix(self, suffixes: tuple[str, ...]) -> list[str]:
        return sorted(
            p
            for name, paths in self.by_name.items()
            if name.endswith(suffixes)
            for p in paths
        )


def _shared_suffix(a: list[str], b: list[str]) -> int:
    count = 0
    for x, y in zip(reversed(a), reversed(b)):
        if x.lower() != y.lower():
            break
        count += 1
    return count


def _mentions(text: str | None, name: str) -> bool:
    return bool(text and name and re.search(rf"\b{re.escape(name)}\b", text))


def _line_of(text: str | None, method: str) -> int | None:
    if not text or not method:
        return None
    pattern = re.compile(rf"\b{re.escape(method)}\s*(?:<[^>\n]*>)?\s*\(")
    for number, line in enumerate(text.splitlines(), start=1):
        if pattern.search(line) and not line.lstrip().startswith(("//", "#", "*")):
            return number
    return None


def resolve_file(frame: StackFrame, index: RepoIndex) -> tuple[str, str]:
    """(path, match) from the file the frame printed."""
    segments = _segments(frame.file)
    if not segments:
        return "", ""
    name = segments[-1].lower()
    candidates = index.by_name.get(name, [])
    if not candidates:
        return "", ""
    scored = sorted(
        ((_shared_suffix(segments, _segments(c)), c) for c in candidates), reverse=True
    )
    best = scored[0][0]
    winners = [c for score, c in scored if score == best]
    if len(winners) > 1:
        return "", "ambiguous"
    winner = winners[0]
    if best >= 2:
        return winner, "path"
    # A lone file name: unique, not a name every project has, and naming the
    # method the frame says it ran.
    stem = Path(name).stem
    if stem in GENERIC_STEMS:
        return "", ""
    if frame.method and not _mentions(index.text(winner), frame.method):
        return "", ""
    return winner, "path"


def _by_compiled(frame: StackFrame, index: RepoIndex) -> tuple[str, str]:
    """`dist/orders/service.js` whose `src/orders/service.ts` is unique."""
    segments = _segments(frame.file)
    if not segments or not segments[-1].endswith((".js", ".mjs", ".cjs")):
        return "", ""
    lowered = [s.lower() for s in segments]
    cut = max(
        (
            i
            for i, s in enumerate(lowered)
            if s in ("dist", "build", "out", "lib", ".next")
        ),
        default=-1,
    )
    if cut < 0:
        return "", ""
    tail = segments[cut + 1 :]
    if not tail:
        return "", ""
    stem = Path(tail[-1]).stem
    found: list[str] = []
    for suffix in (".ts", ".tsx", ".mts", ".cts"):
        for candidate in index.by_name.get((stem + suffix).lower(), []):
            if _shared_suffix([*tail[:-1], stem + suffix], _segments(candidate)) == len(
                tail
            ):
                found.append(candidate)
    if len(found) == 1:
        return found[0], "compiled"
    return ("", "ambiguous") if found else ("", "")


_DECLARATION = r"\b(?:class|record|struct|interface|enum|object|trait)\s+{name}\b"


def _by_symbol(
    frame: StackFrame, index: RepoIndex, outer: list[str]
) -> tuple[str, str]:
    """No usable path: the one source file that declares the type and holds the method."""
    suffixes = LANGUAGE_EXTENSIONS.get(frame.language)
    if not suffixes or not frame.type_name or not frame.method:
        return "", ""
    names = [frame.type_name, *reversed(outer)]
    candidates: list[str] = []
    for name in names:
        for suffix in suffixes:
            candidates.extend(index.by_name.get((name + suffix).lower(), []))
        if candidates:
            break
    if not candidates:
        declaration = re.compile(_DECLARATION.format(name=re.escape(frame.type_name)))
        for relative in index.with_suffix(suffixes)[:MAX_SCAN_FILES]:
            if declaration.search(index.text(relative) or ""):
                candidates.append(relative)
    holding = [
        c for c in dict.fromkeys(candidates) if _mentions(index.text(c), frame.method)
    ]
    if len(holding) == 1:
        return holding[0], "symbol"
    return ("", "ambiguous") if len(holding) > 1 else ("", "")


def _is_framework(frame: StackFrame) -> bool:
    if frame.file and _FRAMEWORK_PATHS.search(frame.file):
        return True
    symbol = frame.symbol.lstrip("(*")
    return bool(symbol and _FRAMEWORK_SYMBOLS.match(symbol))


def resolve(
    trace: StackTrace, project_dir: Path | None, index: RepoIndex | None = None
) -> StackTrace:
    """Attach each frame to this repository's file, when the evidence allows."""
    if project_dir is None and index is None:
        for frame in trace.frames:
            frame.origin = "framework" if _is_framework(frame) else "unknown"
        return trace
    index = index or RepoIndex(Path(project_dir))
    for frame in trace.frames:
        if _is_framework(frame):
            frame.origin = "framework"
            continue
        outer: list[str] = []
        if frame.language == "dotnet":
            _t, _m, outer = split_dotnet(frame.symbol)
        elif frame.language == "java":
            _t, _m, outer = split_java(frame.symbol)
        path, match = ("", "")
        if frame.file:
            path, match = resolve_file(frame, index)
            if not path and match != "ambiguous":
                path, match = _by_compiled(frame, index)
        if not path and match != "ambiguous":
            path, match = _by_symbol(frame, index, outer)
        frame.match = match
        if not path:
            frame.origin = "unknown"
            continue
        frame.path, frame.origin = path, "project"
        text = index.text(path)
        if match == "compiled":
            # A line in the compiled file says nothing about the source.
            frame.line = None
        elif match == "symbol":
            frame.line = _line_of(text, frame.method)
        elif frame.line is not None and text is not None:
            if frame.line > text.count("\n") + 1:
                frame.line, frame.stale_line = None, True
    return trace


def analyze(
    text: str, project_dir: Path | None, index: RepoIndex | None = None
) -> StackTrace | None:
    """Parse and resolve in one call. Never raises."""
    try:
        trace = parse_stacktrace(text)
        return resolve(trace, project_dir, index) if trace else None
    except Exception:  # noqa: BLE001 - a trace nobody could read is not a failed build
        return None


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

MAX_RENDERED_FRAMES = 12


def short_symbol(frame: StackFrame) -> str:
    """`OrdersController.Create` rather than the namespace and the state machine."""
    if frame.type_name and frame.method and frame.method != frame.type_name:
        return f"{frame.type_name}.{frame.method}"
    return frame.type_name or frame.method or frame.symbol


def location(frame: StackFrame) -> str:
    return f"{frame.path}:{frame.line}" if frame.line else frame.path


def render_stacktrace(trace: StackTrace) -> str:
    """The locations an agent opens first, innermost first."""
    header = trace.exception or "stack trace"
    lines = [f"**{header}** ({trace.language})"]
    project = trace.project_frames
    if project:
        lines.append("In this repository, innermost first:")
        for number, frame in enumerate(project[:MAX_RENDERED_FRAMES], start=1):
            what = f" — `{short_symbol(frame)}`" if short_symbol(frame) else ""
            how = {
                "symbol": " (found by class and method; the trace printed no path)",
                "compiled": " (TypeScript source of a compiled frame; line unknown)",
            }.get(frame.match, "")
            if frame.stale_line:
                how += (
                    " (the trace's line is past the end of the file: another version)"
                )
            lines.append(f"{number}. `{location(frame)}`{what}{how}")
        if len(project) > MAX_RENDERED_FRAMES:
            lines.append(
                f"… {len(project) - MAX_RENDERED_FRAMES} more project frame(s)"
            )
    else:
        lines.append("No frame of this trace was found in this repository.")
    unknown = trace.unknown_frames
    if unknown:
        named = ", ".join(
            f"`{short_symbol(f) or Path(f.file).name}`"
            + (" (ambiguous)" if f.match == "ambiguous" else "")
            for f in unknown[:6]
        )
        more = f" and {len(unknown) - 6} more" if len(unknown) > 6 else ""
        lines.append(
            f"Not attached to a file here (not found, or several candidates): {named}{more}."
        )
    if trace.framework_count:
        lines.append(f"{trace.framework_count} framework/runtime frame(s) folded.")
    return "\n".join(lines)
