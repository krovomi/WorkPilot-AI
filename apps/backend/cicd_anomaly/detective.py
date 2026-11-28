"""CI/CD Anomaly Detective — pattern-based log analysis.

Each `AnomalySignal` corresponds to a known infrastructure failure
pattern. Detection is regex-based on log lines so we can run it on every
CI build with negligible overhead.

History-aware mode: when callers pass multiple log samples (one per
recent build), the detective also flags patterns that **recur** across
runs, which is the actually-actionable signal — a single timeout might
be noise, the same timeout 3 builds in a row is a thing to fix.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class AnomalyKind(str, Enum):
    TIMEOUT = "timeout"  # global step/job timeout hit
    OOM = "oom"  # out of memory killed
    DEPENDENCY_CONFLICT = "dependency_conflict"  # package resolver failed
    NETWORK_FAILURE = "network_failure"  # DNS/conn refused/timeout to remote
    DISK_FULL = "disk_full"  # ENOSPC / no space left
    RATE_LIMITED = "rate_limited"  # 429 from registry/API
    AUTH_FAILURE = "auth_failure"  # 401/403, token expired
    INFRASTRUCTURE_FLAKE = "infrastructure_flake"  # docker daemon down, SSH refused
    SLOW_BUILD = "slow_build"  # build duration >> baseline


class Severity(str, Enum):
    CRITICAL = "critical"  # blocks merge / wastes infra
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass(frozen=True)
class _PatternSpec:
    """Describes how to detect one anomaly kind."""

    kind: AnomalyKind
    severity: Severity
    # Each pattern is a tuple (compiled regex, fix id, suggested fix).
    patterns: tuple[tuple[re.Pattern[str], str, str], ...]


# Precompile all patterns once at module load. Lines are matched
# case-insensitive because CI runners shout in mixed case.
def _p(rx: str) -> re.Pattern[str]:
    return re.compile(rx, re.IGNORECASE)


# Each pattern is (regex, fix_id, suggested fix in English). The fix_id is
# stable: the app words the fix in its own language from it
# (``cicdAnomaly.fixes.<fix_id>``); the English text is the fallback for
# other clients. Within a kind the first pattern that matches a line wins,
# so the stack-specific ones come before the generic ones.
_PATTERN_SPECS: tuple[_PatternSpec, ...] = (
    _PatternSpec(
        kind=AnomalyKind.TIMEOUT,
        severity=Severity.HIGH,
        patterns=(
            (
                _p(r"has exceeded the maximum execution time|job .* timed out"),
                "job_timeout",
                "Raise the job's timeout-minutes or split the job into smaller ones.",
            ),
            (
                _p(r"blame-hang|test host process (crashed|exited)|test run aborted"),
                "dotnet_test_hang",
                "Run dotnet test with --blame-hang-timeout to get a dump of the hanging test.",
            ),
            (
                _p(r"blocking waiting for file lock|timeout waiting to lock"),
                "build_lock_wait",
                "Another build holds the cache lock (Cargo, Gradle): give each job its own cache dir.",
            ),
            (
                _p(r"\berror\b.*\btime(d)? ?out\b|the operation was canceled"),
                "step_timeout",
                "Increase the job timeout or split into smaller steps.",
            ),
            (
                _p(r"timed out after \d+"),
                "step_timeout",
                "Increase the relevant per-step timeout.",
            ),
            (
                _p(
                    r"no output (received )?(for|in) (the last )?\d+|\b(hung|is stuck|got stuck)\b"
                ),
                "silent_step",
                "Add a heartbeat log or kill on inactivity.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.OOM,
        severity=Severity.CRITICAL,
        patterns=(
            (
                _p(r"javascript heap out of memory"),
                "node_heap",
                "Set NODE_OPTIONS=--max-old-space-size=… or shard the build.",
            ),
            (
                _p(
                    r"java\.lang\.OutOfMemoryError|jvm heap space is exhausted|gradle build daemon disappeared"
                ),
                "jvm_heap",
                "Bump the JVM heap (-Xmx, org.gradle.jvmargs) or split tests into shards.",
            ),
            (
                _p(r"System\.OutOfMemoryException"),
                "dotnet_memory",
                "Lower MSBuild parallelism (-m:1) or use a runner with more memory.",
            ),
            (
                _p(r"allowed memory size of \d+ bytes exhausted"),
                "php_memory",
                "Raise memory_limit (COMPOSER_MEMORY_LIMIT=-1 for Composer).",
            ),
            (
                _p(r"signal: 9, sigkill|exhausted heap space|\bMemoryError\b"),
                "process_killed",
                "The compiler or test process ran out of memory: lower the parallel jobs or use a bigger runner.",
            ),
            (
                _p(r"\boom-?killed\b|killed.*\boom\b|out of memory|memorykiller"),
                "runner_memory",
                "Bump the runner memory or split the workload.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.DEPENDENCY_CONFLICT,
        severity=Severity.HIGH,
        patterns=(
            (
                _p(r"\bERESOLVE\b|peer dep(endency)? conflict"),
                "npm_peer",
                "Pin the conflicting peer dep, or use --legacy-peer-deps as a temporary patch.",
            ),
            (
                _p(
                    r"\bNU1(605|107|608|109)\b|detected package (downgrade|version outside)"
                ),
                "nuget_conflict",
                "Reference the package version NuGet asks for directly, or use Central Package Management.",
            ),
            (
                _p(r"\bNU1(101|102|103)\b|unable to find package"),
                "nuget_missing",
                "The package or version is not on the configured feeds: check nuget.config and the version.",
            ),
            (
                _p(
                    r"dependency convergence error|conflict\(s\) found for the following module"
                ),
                "jvm_convergence",
                "Align the versions with dependencyManagement (Maven) or a platform/constraints block (Gradle).",
            ),
            (
                _p(
                    r"could not resolve all (files|dependencies|artifacts) for configuration|failed to collect dependencies"
                ),
                "jvm_resolve",
                "Check the repositories block and the version; refresh with --refresh-dependencies.",
            ),
            (
                _p(
                    r"failed to select a version for|failed to get `[^`]+` as a dependency"
                ),
                "cargo_conflict",
                "Relax the version requirement in Cargo.toml or run cargo update -p <crate>.",
            ),
            (
                _p(
                    r"your requirements could not be resolved to an installable set of packages"
                ),
                "composer_conflict",
                "Run composer why-not <package> <version> and relax the constraint that blocks it.",
            ),
            (
                _p(r"version solving failed"),
                "pub_conflict",
                "Run flutter pub outdated and relax the constraint pub names in pubspec.yaml.",
            ),
            (
                _p(r"\bResolutionImpossible\b|conflicting dependencies"),
                "pip_conflict",
                "Pin the shared dependency to a version both packages accept (pip install --dry-run shows it).",
            ),
            (
                _p(r"bundler could not find compatible versions"),
                "bundler_conflict",
                "Run bundle update <gem> or relax its version in the Gemfile.",
            ),
            (
                _p(
                    r"could not resolve package dependencies|dependencies could not be resolved because"
                ),
                "spm_conflict",
                "Relax the version rule in Package.swift or reset the package cache (swift package reset).",
            ),
            (
                _p(r"checksum mismatch|verifying .*: .*: (410 gone|checksum)"),
                "go_checksum",
                "go.sum disagrees with the module proxy: run go mod tidy and check GOPROXY / GONOSUMDB.",
            ),
            (
                _p(r"\bdependency_resolution_failed\b|could not resolve dependencies"),
                "resolver_failed",
                "Inspect the resolver output; pin transitives in the lockfile.",
            ),
            (
                _p(r"version conflict for"),
                "single_version",
                "Pin the offending dep at a single version across the workspace.",
            ),
            (
                _p(r"\bConflictingDependencies\b"),
                "lockfile_audit",
                "Audit lockfile for ambiguous transitives.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.NETWORK_FAILURE,
        severity=Severity.MEDIUM,
        patterns=(
            (
                _p(r"\bNU1301\b|unable to load the service index for source"),
                "nuget_feed",
                "The NuGet feed did not answer: retry, or check the feed URL and its credentials.",
            ),
            (
                _p(
                    r"could not transfer artifact|failed to download from|could not be downloaded"
                ),
                "registry_download",
                "The package registry did not answer: retry with backoff, or cache the packages between runs.",
            ),
            (
                _p(
                    r"could not resolve host|getaddrinfo (failed|enotfound)|name or service not known"
                    r"|failed host lookup|\bEAI_AGAIN\b|\bENOTFOUND\b"
                ),
                "dns",
                "Add DNS retry / cache the resolution at runner start.",
            ),
            (
                _p(
                    r"connection (refused|reset by peer|timed out)|\bECONNRESET\b|\bETIMEDOUT\b|dial tcp .*i/o timeout"
                ),
                "connection",
                "Wrap the network call in a retry-with-backoff; check upstream status.",
            ),
            (
                _p(r"ssl handshake (failed|error)"),
                "tls",
                "Check the registry's TLS cert / clock skew on the runner.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.DISK_FULL,
        severity=Severity.CRITICAL,
        patterns=(
            (
                _p(
                    r"no space left on device|enospc|disk quota exceeded|not enough space on the disk"
                ),
                "disk_cleanup",
                "Add a `df -h` step + cleanup of /tmp + docker prune before the failing step.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.RATE_LIMITED,
        severity=Severity.MEDIUM,
        patterns=(
            (
                _p(r"\btoomanyrequests\b|pull rate limit"),
                "docker_pull_limit",
                "Log in to the registry before pulling, or mirror the image.",
            ),
            (
                _p(
                    r"\b(http|status|code|response|error)\b\D{0,12}\b429\b|\b429\b\D{0,3}too many"
                    r"|too many requests|rate limit (exceeded|reached)"
                ),
                "backoff",
                "Add backoff + jitter; or authenticate to a higher-quota tier.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.AUTH_FAILURE,
        severity=Severity.HIGH,
        patterns=(
            (
                _p(r"bad credentials|permission denied \(publickey\)"),
                "ssh_key",
                "Refresh the SSH key or PAT used by the runner.",
            ),
            (
                _p(
                    r"\b(http|status|code|response|error|returned)\b\D{0,12}\b(401|403)\b"
                    r"|\b(401|403)\b\W{0,3}(unauthorized|forbidden)|\bE40[13]\b"
                    r"|\bunauthorized\b|invalid (credentials|token)|authentication required"
                ),
                "ci_token",
                "Rotate the CI token; ensure the secret is exposed to the failing job.",
            ),
        ),
    ),
    _PatternSpec(
        kind=AnomalyKind.INFRASTRUCTURE_FLAKE,
        severity=Severity.HIGH,
        patterns=(
            (
                _p(
                    r"docker daemon (is )?not (running|responding)|cannot connect to the docker daemon"
                ),
                "docker_daemon",
                "Restart docker / use a fresh runner image.",
            ),
            (
                _p(
                    r"runner has received a shutdown signal|runner offline|lost communication with the server|host unreachable"
                ),
                "runner_lost",
                "Mark the runner as offline; switch to a healthy pool.",
            ),
            (
                _p(r"received signal\s*15|terminated by sigterm"),
                "preempted",
                "The runner was preempted; mark the build as retryable.",
            ),
        ),
    ),
)


@dataclass
class AnomalySignal:
    """A single detected anomaly inside one log sample."""

    kind: AnomalyKind
    severity: Severity
    matching_line: str
    line_number: int
    suggested_fix: str
    log_label: str = ""  # which sample matched (e.g. "build-1234")
    fix_id: str = ""  # stable id of the fix, worded by the app in its language

    def to_dict(self) -> dict:
        return {
            "kind": self.kind.value,
            "severity": self.severity.value,
            "matching_line": self.matching_line[:300],
            "line_number": self.line_number,
            "suggested_fix": self.suggested_fix,
            "fix_id": self.fix_id,
            "log_label": self.log_label,
        }


@dataclass
class AnomalyReport:
    signals: list[AnomalySignal] = field(default_factory=list)
    recurring_kinds: list[str] = field(default_factory=list)
    summary: dict[str, int] = field(default_factory=dict)
    fix_recommendations: list[str] = field(default_factory=list)
    # The same recommendations, structured for a client that words them itself.
    recommendations: list[dict] = field(default_factory=list)

    @property
    def has_critical(self) -> bool:
        return any(s.severity == Severity.CRITICAL for s in self.signals)

    def to_dict(self) -> dict:
        return {
            "signals": [s.to_dict() for s in self.signals],
            "recurring_kinds": self.recurring_kinds,
            "summary": self.summary,
            "fix_recommendations": self.fix_recommendations,
            "recommendations": self.recommendations,
            "has_critical": self.has_critical,
        }


class AnomalyDetective:
    """Scan one or many CI log samples for known failure patterns."""

    # An anomaly is "recurring" if it appears in this many distinct
    # log samples (history mode).
    RECURRING_THRESHOLD = 2

    # Hard cap on log size we'll scan to keep this O(N) and prevent
    # accidental DoS by huge artefacts. Roughly 8 MB.
    MAX_LOG_BYTES = 8 * 1024 * 1024

    def scan(self, log: str, log_label: str = "") -> list[AnomalySignal]:
        """Scan a single log blob and return all matching signals."""
        if log is None:
            return []
        if len(log) > self.MAX_LOG_BYTES:
            log = log[: self.MAX_LOG_BYTES]
            logger.warning("Log truncated to %d bytes for scan", self.MAX_LOG_BYTES)

        signals: list[AnomalySignal] = []
        # Track (kind, line) we already emitted to avoid double-counting
        # the same line matching multiple regexes for the same kind.
        seen: set[tuple[AnomalyKind, int]] = set()

        lines = log.splitlines()
        for spec in _PATTERN_SPECS:
            for line_no, line in enumerate(lines, start=1):
                for pattern, fix_id, suggestion in spec.patterns:
                    if pattern.search(line):
                        key = (spec.kind, line_no)
                        if key in seen:
                            continue
                        seen.add(key)
                        signals.append(
                            AnomalySignal(
                                kind=spec.kind,
                                severity=spec.severity,
                                matching_line=line.strip(),
                                line_number=line_no,
                                suggested_fix=suggestion,
                                log_label=log_label,
                                fix_id=fix_id,
                            )
                        )
                        break  # one match per line per kind is enough
        return signals

    def analyse(
        self,
        logs: Iterable[tuple[str, str]] | str,
    ) -> AnomalyReport:
        """Scan one or several log samples and produce a report.

        Args:
            logs: either a single log string, or an iterable of
                ``(label, log_text)`` tuples for history-aware analysis.
        """
        if isinstance(logs, str):
            samples = [("", logs)]
        else:
            samples = list(logs)

        all_signals: list[AnomalySignal] = []
        per_label_kinds: dict[str, set[AnomalyKind]] = {}

        for label, text in samples:
            sigs = self.scan(text, log_label=label)
            all_signals.extend(sigs)
            per_label_kinds[label] = {s.kind for s in sigs}

        # Recurring = same kind appears in ≥ THRESHOLD distinct labels.
        kind_label_counts: Counter[AnomalyKind] = Counter()
        for kinds in per_label_kinds.values():
            for k in kinds:
                kind_label_counts[k] += 1
        recurring = [
            k.value
            for k, c in kind_label_counts.items()
            if c >= self.RECURRING_THRESHOLD
        ]

        summary = {
            "samples": len(samples),
            "total_signals": len(all_signals),
            "by_kind": dict(Counter(s.kind.value for s in all_signals)),
            "by_severity": dict(Counter(s.severity.value for s in all_signals)),
        }

        picked = self._pick_recommendations(all_signals, recurring)

        return AnomalyReport(
            signals=all_signals,
            recurring_kinds=recurring,
            summary=summary,
            fix_recommendations=[
                f"[recurring] {s.suggested_fix}" if again else s.suggested_fix
                for s, again in picked
            ],
            recommendations=[
                {
                    "kind": s.kind.value,
                    "fix_id": s.fix_id,
                    "suggested_fix": s.suggested_fix,
                    "recurring": again,
                }
                for s, again in picked
            ],
        )

    # ------------------------------------------------------------------
    # Internals

    def _pick_recommendations(
        self, signals: list[AnomalySignal], recurring: list[str]
    ) -> list[tuple[AnomalySignal, bool]]:
        """One signal per *kind*, recurring kinds first, then by severity."""
        seen_kinds: set[str] = set()
        picked: list[tuple[AnomalySignal, bool]] = []

        recurring_set = set(recurring)
        for s in signals:
            if s.kind.value in recurring_set and s.kind.value not in seen_kinds:
                picked.append((s, True))
                seen_kinds.add(s.kind.value)

        sev_order = {
            Severity.CRITICAL: 0,
            Severity.HIGH: 1,
            Severity.MEDIUM: 2,
            Severity.LOW: 3,
        }
        for s in sorted(signals, key=lambda x: sev_order[x.severity]):
            if s.kind.value not in seen_kinds:
                picked.append((s, False))
                seen_kinds.add(s.kind.value)

        return picked


# Convenience helpers for callers who just want a one-shot.
def scan_log(log: str) -> list[dict]:
    """One-shot helper: scan one log, return dicts."""
    return [s.to_dict() for s in AnomalyDetective().scan(log)]
