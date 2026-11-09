"""What the red team attacks: the code the task changed, read without a model.

For each source file of the diff (tests, vendored and generated folders left
out, as for the mutation gate): the functions the changed lines belong to, whether the file serves HTTP routes, and whether it hands text
to a language model (the prompt injection mode). And the static half of the
concurrency mode, on every stack: check-then-act on the filesystem, and shared
mutable state written from concurrent code without a lock. Those are
**warnings**: possible, not shown to break.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from mutation_gate.scope import changed_lines

__all__ = ["Surface", "Target", "attack_surface", "language_of"]

MAX_TARGETS = 12
MAX_FUNCTIONS = 15
MAX_FILE_BYTES = 512 * 1024

_LANGUAGES = {
    ".py": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "javascript", ".tsx": "javascript", ".mts": "javascript", ".cts": "javascript",
    ".vue": "javascript", ".svelte": "javascript",
    ".cs": "csharp", ".fs": "csharp", ".vb": "csharp",
    ".java": "jvm", ".kt": "jvm", ".kts": "jvm", ".groovy": "jvm", ".scala": "jvm",
    ".go": "go", ".rs": "rust", ".php": "php", ".rb": "ruby",
    ".swift": "swift", ".dart": "dart", ".ex": "elixir", ".exs": "elixir",
    ".c": "c", ".cc": "c", ".cpp": "c", ".h": "c", ".hpp": "c",
}  # fmt: skip

_KEYWORDS = {
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "function",
    "new",
    "else",
}
_FUNCTIONS: dict[str, tuple[re.Pattern[str], ...]] = {
    "python": (re.compile(r"^\s*(?:async\s+)?def\s+(\w+)"),),
    "javascript": (
        re.compile(r"\bfunction\s*\*?\s*(\w+)\s*\("),
        re.compile(r"\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>"),
        re.compile(r"^\s*(?:(?:public|private|protected|static|async|override|get|set)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{"),
    ),
    "csharp": (
        re.compile(r"\b(?:public|internal|protected|private)\s+(?:(?:static|async|override|virtual|sealed|partial)\s+)*[\w<>\[\],.?\s]+?\s+(\w+)\s*\("),
    ),
    "jvm": (
        re.compile(r"\bfun\s+(?:<[^>]+>\s*)?(?:\w+\.)?(\w+)\s*\("),
        re.compile(r"\b(?:public|protected|private|static)\s+(?:(?:static|final|synchronized|abstract)\s+)*[\w<>\[\],.?\s]+?\s+(\w+)\s*\("),
        re.compile(r"\bdef\s+(\w+)"),
    ),
    "go": (re.compile(r"^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\("),),
    "rust": (re.compile(r"\bfn\s+(\w+)"),),
    "php": (re.compile(r"\bfunction\s+(\w+)\s*\("),),
    "ruby": (re.compile(r"^\s*def\s+(?:self\.)?(\w+[?!]?)"),),
    "swift": (re.compile(r"\bfunc\s+(\w+)"),),
    "dart": (re.compile(r"^\s*(?:[\w<>?,]+\s+)+(\w+)\s*\([^;{]*\)\s*(?:async\s*)?\{"),),
    "elixir": (re.compile(r"^\s*defp?\s+(\w+[?!]?)"),),
    "c": (re.compile(r"^\s*(?:[\w*&<>:,]+\s+)+\**(\w+)\s*\([^;]*\)\s*\{?\s*$"),),
}  # fmt: skip

_ENDPOINT = re.compile(
    r"\[Http(?:Get|Post|Put|Patch|Delete)\b|\bMap(?:Get|Post|Put|Patch|Delete)\s*\("
    r"|@(?:app|router|api|bp|blueprint)\.(?:get|post|put|patch|delete|route)\s*\("
    r"|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@(?:GET|POST|PUT|DELETE|Path)\b"
    r"|\b(?:app|router|server|fastify)\.(?:get|post|put|patch|delete)\s*\(\s*['\"`/]"
    r"|\bRoute::(?:get|post|put|patch|delete)\s*\(|\bHandleFunc\s*\("
    r"|#\[(?:get|post|put|patch|delete)\(|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b"
)
_LLM = re.compile(
    r"\b(?:anthropic|Anthropic|openai|OpenAI|ChatCompletion|chat\.completions|messages\.create"
    r"|create_client|create_agent_client|generateText|streamText|generateObject|@ai-sdk"
    r"|langchain|LangChain|IChatClient|IChatCompletionService|SemanticKernel|Kernel\.CreateBuilder"
    r"|ollama|Ollama|GenerativeModel|google\.genai|bedrock-runtime|BedrockRuntime|litellm"
    r"|ChatClient|ChatModel|ChatOpenAI|ChatAnthropic|llama_index|LlamaIndex)\b"
)

_EXISTS = re.compile(
    r"os\.path\.(?:exists|isfile|isdir)\s*\(|\.exists\s*\(\s*\)|\.is_file\s*\(\s*\)"
    r"|\b(?:File|Directory)\.Exists\s*\(|\bfs\.existsSync\s*\(|\bFiles\.(?:exists|notExists)\s*\("
    r"|\bfile_exists\s*\(|\bFile\.exists?\?\s*\(|\bos\.Stat\s*\("
)
_ACT = re.compile(
    r"\bopen\s*\(|\.write|\bWrite|\bCreate|\bunlink|\bremove|\bDelete|\bmkdir|\bMove|\brename"
    r"|\bcopy|\bCopy|\bwriteFile|\bOpenWrite|\bos\.Create|\bfopen"
)
_CONCURRENT = re.compile(
    r"\bthreading\b|\bThread\s*\(|ThreadPool|ProcessPool|asyncio\.gather|create_task"
    r"|\bTask\.(?:Run|WhenAll)\b|\bParallel\.|\bgo\s+func\b|\bgo\s+\w+\(|tokio::spawn"
    r"|thread::spawn|rayon|Promise\.all|new\s+Worker\s*\(|ExecutorService|CompletableFuture"
    r"|@Async\b|\blaunch\s*\{|GlobalScope|DispatchQueue|Task\s*\{|Isolate\.spawn|Task\.async"
)
_SHARED_WRITE = re.compile(
    r"^\s*global\s+\w+|^[a-z_]\w*\s*(?::[^=]+)?=\s*(?:\[\]|\{\}|dict\(|list\(|set\(|defaultdict\()"
    r"|\bstatic\s+(?!readonly\b|final\b|const\b)(?:[\w<>\[\],.?]+\s+)+\w+\s*=(?!=)"
    r"|^(?:let|var)\s+\w+\s*=|^var\s+\w+\s+(?:=\s*)?(?:map\[|\[\]|make\()|\bstatic\s+mut\b"
    r"|^\s*@@\w+\s*=|\$GLOBALS\b"
)
_LOCK = re.compile(
    r"\bLock\s*\(|\block\s*\(|\bMutex\b|\bRLock\b|\bsynchronized\b|\bInterlocked\b|\bSemaphore"
    r"|\batomic\b|\bAtomic\w+|Concurrent(?:Dictionary|HashMap|Bag|Queue)|sync\.(?:Mutex|RWMutex|Map)"
    r"|\bRwLock\b|asyncio\.Lock|\bwithLock\b|\bReentrantLock\b|\bactor\b"
)


@dataclass
class Target:
    path: str
    language: str
    functions: list[str] = field(default_factory=list)
    endpoint: bool = False
    llm: bool = False

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "language": self.language,
            "functions": self.functions,
            "endpoint": self.endpoint,
            "llm": self.llm,
        }


@dataclass
class Surface:
    targets: list[Target] = field(default_factory=list)
    #: ``{"path", "line", "kind", "message"}``: static, never blocking.
    warnings: list[dict] = field(default_factory=list)

    @property
    def sources(self) -> list[str]:
        return [t.path for t in self.targets]


def language_of(path: str) -> str | None:
    return _LANGUAGES.get(PurePosixPath(path).suffix.lower())


def _read(path: Path) -> str | None:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _functions(language: str, lines: list[str], wanted: set[int]) -> list[str]:
    """The function each changed line belongs to: the last one defined at or above it."""
    patterns = _FUNCTIONS.get(language, ())
    found: list[str] = []
    current: str | None = None
    for number, text in enumerate(lines, start=1):
        for pattern in patterns:
            match = pattern.search(text)
            if match and match.group(1) not in _KEYWORDS:
                current = match.group(1)
                break
        if number in wanted and current:
            found.append(current)
    return list(dict.fromkeys(found))[:MAX_FUNCTIONS]


def _toctou(path: str, lines: list[str], wanted: set[int]) -> list[dict]:
    warnings = []
    for number in sorted(wanted):
        if number > len(lines) or not _EXISTS.search(lines[number - 1]):
            continue
        window = lines[number : number + 4]
        if any(_ACT.search(line) for line in window):
            warnings.append(
                {
                    "path": path,
                    "line": number,
                    "kind": "toctou",
                    "message": "the file is checked, then used: another process can "
                    "create, change or delete it in between",
                }
            )
    return warnings


def _shared_state(
    path: str, text: str, lines: list[str], wanted: set[int]
) -> list[dict]:
    if not _CONCURRENT.search(text) or _LOCK.search(text):
        return []
    for number in sorted(wanted):
        if number <= len(lines) and _SHARED_WRITE.search(lines[number - 1]):
            return [
                {
                    "path": path,
                    "line": number,
                    "kind": "shared-state",
                    "message": "state shared by the whole process, in code that runs "
                    "concurrently, with no lock in the file",
                }
            ]
    return []


def attack_surface(project_dir: Path, base: str, files: list[str]) -> Surface:
    """The targets and static warnings of the diff. Raises ``OSError`` if git cannot answer."""
    project_dir = Path(project_dir)
    surface = Surface()
    for path, wanted in sorted(changed_lines(project_dir, base, files).items()):
        language = language_of(path)
        if language is None:
            continue
        text = _read(project_dir / path)
        if text is None:
            continue
        lines = text.splitlines()
        changed = "\n".join(lines[n - 1] for n in sorted(wanted) if n <= len(lines))
        surface.warnings += _toctou(path, lines, wanted)
        surface.warnings += _shared_state(path, text, lines, wanted)
        if len(surface.targets) >= MAX_TARGETS:
            continue
        surface.targets.append(
            Target(
                path=path,
                language=language,
                functions=_functions(language, lines, wanted),
                endpoint=bool(_ENDPOINT.search(changed) or _ENDPOINT.search(text)),
                llm=bool(_LLM.search(text)),
            )
        )
    return surface
