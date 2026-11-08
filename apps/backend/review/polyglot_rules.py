"""Review rules for the stacks beyond Python and JS/TS.

``ai_code_review.BUILTIN_RULES`` started with Python and JavaScript rules;
these rows bring the same kinds of findings (silent error handling, debug
output left in, crash-prone shortcuts, injection risks) to .NET, Java,
Kotlin, Go, Rust, Swift, PHP, Ruby, Dart and C/C++. Each pattern is matched
against one added line, so a rule only flags what a single line proves.

Plain data on purpose: ``ai_code_review`` turns each row into a
``ReviewRule``, which keeps this module free of an import cycle.
"""

from __future__ import annotations

# (rule_id, pattern, message, severity, category, suggestion, languages)
POLYGLOT_RULES: tuple[tuple[str, str, str, str, str, str, tuple[str, ...]], ...] = (
    # Silent error handling
    (
        "ERR003",
        r"catch\s*(?:\([^)]*\))?\s*\{\s*\}",
        "Empty catch block — errors will be silently swallowed.",
        "warning",
        "error_handling",
        "Log the exception or handle it explicitly.",
        ("csharp", "java", "kotlin", "scala", "php", "dart", "swift", "cpp"),
    ),
    (
        "ERR004",
        r"rescue(?:\s+\w+(?:::\w+)*)?\s*(?:=>\s*\w+)?\s*;\s*end\b|rescue\s+nil\b",
        "Rescue that drops the error — failures will go unnoticed.",
        "warning",
        "error_handling",
        "Log the error or rescue a specific exception and handle it.",
        ("ruby",),
    ),
    (
        "ERR005",
        r"\b_\s*(?:,\s*_\s*)?=\s*\w+(?:\.\w+)*\([^)]*\)\s*$|\berr\s*!=\s*nil\s*\{\s*\}",
        "Go error discarded — the call can fail without anyone knowing.",
        "warning",
        "error_handling",
        "Check the returned error and return or log it.",
        ("go",),
    ),
    # Crash-prone shortcuts
    (
        "BUG005",
        r"\.unwrap\(\)|\.expect\(\s*\"\"\s*\)",
        "`unwrap()` panics on None/Err — the program will crash on bad input.",
        "warning",
        "bug_risk",
        "Propagate with `?`, or match / use `unwrap_or_else` with a clear message.",
        ("rust",),
    ),
    (
        "BUG006",
        r"\btry!|\bas!\s",
        "Forced `try!` / `as!` crashes at runtime when it fails.",
        "warning",
        "bug_risk",
        "Use `try` inside do/catch, or `as?` with a guard.",
        ("swift",),
    ),
    (
        "BUG007",
        r"\w!!(?:\.|\s|$|\))",
        "`!!` throws a NullPointerException when the value is null.",
        "warning",
        "bug_risk",
        "Use `?.`, `?:` or an explicit null check.",
        ("kotlin",),
    ),
    (
        "BUG008",
        r"\basync\s+void\s+\w+\s*\(",
        "`async void` method — its exceptions crash the process and it cannot be awaited.",
        "error",
        "bug_risk",
        "Return `Task` (keep `async void` for event handlers only).",
        ("csharp",),
    ),
    (
        "BUG009",
        r"\.Result\b(?!\s*=)|\.Wait\(\s*\)|\.GetAwaiter\(\)\.GetResult\(\)",
        "Blocking on a Task (`.Result` / `.Wait()`) — risk of deadlock and thread starvation.",
        "warning",
        "performance",
        "`await` the task instead.",
        ("csharp",),
    ),
    (
        "BUG010",
        r"(?<![\w.])(?:[A-Za-z_]\w*\s*!\s*\.|\w+!\[)",
        "Null-forgiving `!` or force-unwrapped access — crashes when the value is null.",
        "suggestion",
        "bug_risk",
        "Check for null first, or use `?.` / `??`.",
        ("dart",),
    ),
    # Debug output left in
    (
        "BUG011",
        r"\bConsole\.Write(?:Line)?\s*\(|\bDebug\.WriteLine\s*\(",
        "Console output found — use ILogger instead.",
        "info",
        "best_practice",
        "Inject ILogger<T> and log at the right level.",
        ("csharp",),
    ),
    (
        "BUG012",
        r"\bSystem\.(?:out|err)\.print(?:ln|f)?\s*\(|\be\.printStackTrace\(\)",
        "Console output found — use a logger (SLF4J, java.util.logging).",
        "info",
        "best_practice",
        "Replace with logger.info() / logger.error().",
        ("java", "scala"),
    ),
    (
        "BUG013",
        r"^\s*println\s*\(|\bprintStackTrace\(\)",
        "Console output found — use a logger.",
        "info",
        "best_practice",
        "Replace with a logger call.",
        ("kotlin", "scala"),
    ),
    (
        "BUG014",
        r"\bfmt\.Print(?:ln|f)?\s*\(|^\s*println\s*\(",
        "Console output found — use the log or slog package.",
        "info",
        "best_practice",
        "Replace with slog.Info() / log.Printf().",
        ("go",),
    ),
    (
        "BUG015",
        r"\b(?:println|dbg|eprintln)!\s*\(",
        "Debug output macro found — use the log / tracing crate.",
        "info",
        "best_practice",
        "Replace with tracing::info!() or log::debug!().",
        ("rust",),
    ),
    (
        "BUG016",
        r"\b(?:var_dump|print_r|dd|dump)\s*\(",
        "Debug dump found — remove it before merge.",
        "warning",
        "best_practice",
        "Use a PSR-3 logger instead.",
        ("php",),
    ),
    (
        "BUG017",
        r"^\s*(?:puts|p|pp)\s+\S|\bbinding\.pry\b|\bbyebug\b",
        "Debug output or breakpoint found — remove it before merge.",
        "warning",
        "best_practice",
        "Use Rails.logger or a Logger instance.",
        ("ruby",),
    ),
    (
        "BUG018",
        r"^\s*(?:print|debugPrint)\s*\(",
        "print() found — use a logger (package:logging, os.log).",
        "info",
        "best_practice",
        "Replace with a logger call.",
        ("dart", "swift"),
    ),
    (
        "BUG019",
        r"\bstd::(?:cout|cerr)\s*<<|\bprintf\s*\(",
        "Console output found — use the project's logger.",
        "info",
        "best_practice",
        "Replace with a logging call.",
        ("cpp", "c"),
    ),
    # Security
    (
        "SEC005",
        r"(?i)\"\s*(?:select|insert|update|delete)\b[^\"]*\"\s*(?:\+|\.)\s*\$?\w|"
        r"\$\"\s*(?:select|insert|update|delete)\b[^\"]*\{|"
        r"\bf[\"']\s*(?:select|insert|update|delete)\b[^\"']*\{",
        "SQL built by string concatenation — SQL injection risk.",
        "critical",
        "security",
        "Use parameterised queries (placeholders / bound parameters).",
        (),
    ),
    (
        "SEC006",
        r"\b(?:Runtime\.getRuntime\(\)\.exec|Process\.Start|exec\.Command\(\s*\"(?:sh|bash|cmd)\"|"
        r"shell_exec|passthru|system)\s*\(",
        "Shell command execution — command injection risk if any argument is user input.",
        "error",
        "security",
        "Pass arguments as a list, never through a shell, and validate them.",
        ("java", "kotlin", "csharp", "go", "php", "ruby"),
    ),
    (
        "SEC007",
        r"\bunsafe\s*\{",
        "`unsafe` block — memory safety is no longer checked here.",
        "suggestion",
        "security",
        "Document the invariant with a `// SAFETY:` comment, or avoid `unsafe`.",
        ("rust",),
    ),
    (
        "SEC008",
        r"\b(?:eval|unserialize)\s*\(",
        "`eval()` / `unserialize()` on data — code injection risk.",
        "critical",
        "security",
        "Parse the data explicitly (json_decode, a dedicated parser).",
        ("php", "ruby"),
    ),
    (
        "SEC009",
        r"\b(?:strcpy|strcat|sprintf|gets)\s*\(",
        "Unbounded C string function — buffer overflow risk.",
        "error",
        "security",
        "Use the bounded variant (strncpy/snprintf/fgets) or std::string.",
        ("cpp", "c"),
    ),
)
