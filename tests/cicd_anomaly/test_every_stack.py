"""CI failures of every stack are recognised, and ordinary lines are not.

The detective knew npm and the JVM heap only, and its `hang|stuck` and bare
`401`/`403`/`429` patterns fired on lines such as "Changed 3 files" or
"tests 401 to 420 passed".
"""

from __future__ import annotations

import pytest
from cicd_anomaly import AnomalyDetective, AnomalyKind
from cicd_anomaly.detective import _PATTERN_SPECS

LINES = [
    # .NET
    (
        "error NU1605: Detected package downgrade: Microsoft.Extensions.Logging from 9.0.0 to 8.0.0",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "nuget_conflict",
    ),
    (
        "error NU1101: Unable to find package Contoso.Core. No packages exist with this id",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "nuget_missing",
    ),
    (
        "error NU1301: Unable to load the service index for source https://pkgs.dev.azure.com/x/index.json",
        AnomalyKind.NETWORK_FAILURE,
        "nuget_feed",
    ),
    (
        "The active test run was aborted. Reason: Test host process crashed",
        AnomalyKind.TIMEOUT,
        "dotnet_test_hang",
    ),
    (
        "Unhandled exception. System.OutOfMemoryException: Insufficient memory",
        AnomalyKind.OOM,
        "dotnet_memory",
    ),
    (
        "System.IO.IOException: There is not enough space on the disk.",
        AnomalyKind.DISK_FULL,
        "disk_cleanup",
    ),
    # Maven / Gradle / Kotlin
    (
        "[ERROR] Failed to execute goal on project api: Could not resolve dependencies for project com.acme:api:jar:1.0",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "resolver_failed",
    ),
    (
        "[ERROR] Could not transfer artifact org.slf4j:slf4j-api:pom:2.0.9 from/to central",
        AnomalyKind.NETWORK_FAILURE,
        "registry_download",
    ),
    (
        "Dependency convergence error for com.google.guava:guava:32.1.2-jre",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "jvm_convergence",
    ),
    (
        "> Could not resolve all files for configuration ':app:debugRuntimeClasspath'.",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "jvm_resolve",
    ),
    (
        "Expiring Daemon because JVM heap space is exhausted",
        AnomalyKind.OOM,
        "jvm_heap",
    ),
    # Rust
    (
        "error: failed to select a version for `serde`.",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "cargo_conflict",
    ),
    (
        "    Blocking waiting for file lock on package cache",
        AnomalyKind.TIMEOUT,
        "build_lock_wait",
    ),
    (
        'error: could not compile `app` (bin "app") due to previous error; (signal: 9, SIGKILL: kill)',
        AnomalyKind.OOM,
        "process_killed",
    ),
    # PHP
    (
        "Your requirements could not be resolved to an installable set of packages.",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "composer_conflict",
    ),
    (
        "PHP Fatal error:  Allowed memory size of 1610612736 bytes exhausted (tried to allocate 4096 bytes)",
        AnomalyKind.OOM,
        "php_memory",
    ),
    # Flutter / Dart
    (
        "Because app depends on intl ^0.19.0 which requires SDK version >=3.3.0, version solving failed.",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "pub_conflict",
    ),
    (
        "SocketException: Failed host lookup: 'pub.dev'",
        AnomalyKind.NETWORK_FAILURE,
        "dns",
    ),
    # Go
    (
        "verifying github.com/acme/lib@v1.2.3: checksum mismatch",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "go_checksum",
    ),
    (
        "dial tcp 142.250.1.1:443: i/o timeout",
        AnomalyKind.NETWORK_FAILURE,
        "connection",
    ),
    ("panic: test timed out after 10m0s", AnomalyKind.TIMEOUT, "step_timeout"),
    # Python / Ruby / Swift
    (
        "ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "pip_conflict",
    ),
    (
        'Bundler could not find compatible versions for gem "rails":',
        AnomalyKind.DEPENDENCY_CONFLICT,
        "bundler_conflict",
    ),
    (
        "xcodebuild: error: Could not resolve package dependencies:",
        AnomalyKind.DEPENDENCY_CONFLICT,
        "spm_conflict",
    ),
    # npm / registries / runners
    ("npm error code E401", AnomalyKind.AUTH_FAILURE, "ci_token"),
    (
        "npm error network request to https://registry.npmjs.org/x failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org",
        AnomalyKind.NETWORK_FAILURE,
        "dns",
    ),
    (
        "toomanyrequests: You have reached your pull rate limit.",
        AnomalyKind.RATE_LIMITED,
        "docker_pull_limit",
    ),
    (
        "The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 360 minutes.",
        AnomalyKind.TIMEOUT,
        "job_timeout",
    ),
    (
        "The runner has received a shutdown signal.",
        AnomalyKind.INFRASTRUCTURE_FLAKE,
        "runner_lost",
    ),
]


@pytest.mark.parametrize(
    ("line", "kind", "fix_id"), LINES, ids=[x[2] + str(i) for i, x in enumerate(LINES)]
)
def test_each_stack_failure_is_recognised_with_its_fix(line, kind, fix_id):
    signals = [s for s in AnomalyDetective().scan(line) if s.kind == kind]
    assert signals, line
    assert signals[0].fix_id == fix_id


ORDINARY = [
    "Changed 3 files, 120 insertions(+)",
    "Exchange rates loaded",
    "Test run: tests 401 to 420 passed",
    "Processed 403 records in 2.1s",
    "Line 429: unused variable `x`",
    "Discharge summary template rendered",
    "Using cached forbidden-words list",  # a word in a file name, no HTTP status
]


@pytest.mark.parametrize("line", ORDINARY)
def test_ordinary_lines_raise_nothing(line):
    assert AnomalyDetective().scan(line) == []


def test_every_pattern_has_a_fix_id_and_a_fallback_text():
    ids = [fix_id for spec in _PATTERN_SPECS for _, fix_id, _ in spec.patterns]
    assert all(ids)
    assert all(text for spec in _PATTERN_SPECS for _, _, text in spec.patterns)


def test_report_gives_structured_recommendations_recurring_first():
    report = (
        AnomalyDetective()
        .analyse(
            [
                (
                    "build-1",
                    "error NU1301: Unable to load the service index for source x\nNo space left on device",
                ),
                (
                    "build-2",
                    "error NU1301: Unable to load the service index for source x",
                ),
            ]
        )
        .to_dict()
    )
    first = report["recommendations"][0]
    assert first == {
        "kind": "network_failure",
        "fix_id": "nuget_feed",
        "suggested_fix": first["suggested_fix"],
        "recurring": True,
    }
    assert {r["fix_id"] for r in report["recommendations"]} == {
        "nuget_feed",
        "disk_cleanup",
    }
    assert report["fix_recommendations"][0].startswith("[recurring] ")


def test_every_fix_id_is_worded_in_french_and_english():
    import json
    from pathlib import Path

    locales = (
        Path(__file__).resolve().parents[2] / "apps/frontend/src/shared/i18n/locales"
    )
    ids = {fix_id for spec in _PATTERN_SPECS for _, fix_id, _ in spec.patterns}
    for lang in ("fr", "en"):
        data = json.loads((locales / lang / "phase35.json").read_text(encoding="utf-8"))
        assert ids <= set(data["cicdAnomaly"]["fixes"]), lang
