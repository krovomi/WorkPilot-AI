"""Each packaged app is audited for what it exposes before it is uploaded (REA, lot C).

Nothing looked at the shipped artifact itself: the release had no Electron fuse
set, so ``ELECTRON_RUN_AS_NODE`` turned the signed app into a plain Node.js
runtime and ``--inspect`` opened a debugger on it. electron-builder now flips
the fuses while packaging, and ``scripts/release-exposure-audit.cjs`` runs
REA's static ``audit-release-exposure`` on each unpacked app, failing the job
on an ``exposed`` check of high severity.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "apps" / "frontend"
SCRIPT = FRONTEND / "scripts" / "release-exposure-audit.cjs"
PIN = ROOT / "apps" / "backend" / "rea" / "pin.json"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"


def _check(check_id: str, status: str, severity: str | None) -> dict:
    return {
        "id": check_id,
        "status": status,
        "severity": severity,
        "confidence": "observed",
        "observation": {"counts": {}, "samples": []},
        "locations": [],
        "remediation": f"fix {check_id}",
        "next_probe": None,
    }


#: The shape of REA 6.9.0's report, statuses from its own "before" fixture.
REPORT = {
    "target": {
        "selected_path": "/dist/linux-unpacked",
        "kind": "directory",
        "format": "directory",
        "sha256": None,
    },
    "checks": [
        _check("javascript.source_map_sources", "not_observed", None),
        _check("electron.run_as_node", "exposed", "high"),
        _check("electron.asar_integrity", "unknown", None),
        _check("electron.only_load_from_asar", "exposed", "medium"),
        _check("packaging.extractable_payload", "exposed", "low"),
        _check("native.hardening", "not_assessed", None),
    ],
    "summary": {},
    "coverage": {"allowances": [], "omitted": []},
    "limitations": ["This report states what static analysis recovered."],
}


def _node(expression: str, *args: object):
    """Evaluate ``expression`` with the script's exports bound to ``m``."""
    probe = (
        "const m = require(process.argv[1]);"
        "const args = JSON.parse(process.argv[2]);"
        f"process.stdout.write(JSON.stringify(({expression})));"
    )
    out = subprocess.run(
        ["node", "-e", probe, str(SCRIPT), json.dumps(list(args))],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,
    )
    return json.loads(out.stdout)


def test_the_pin_names_one_exact_release():
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    assert pin["package"] == "rea-agents"
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin["version"]), "never a range or latest"
    assert pin["node"], "the Node.js versions this REA release accepts"
    assert _node("m.readPin(args[0]).version", str(PIN)) == pin["version"]


def test_the_audit_runs_the_pinned_release_never_latest():
    args = _node(
        "m.auditArgs(m.readPin(args[0]), '/dist/app', 'high')", str(PIN)
    )
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    assert f"rea-agents@{pin['version']}" in args
    assert not any("latest" in a for a in args)
    assert args[args.index("--fail_on") + 1] == "high"
    assert "--json" in args


def test_node_versions_follow_the_pin_ranges():
    ranges = ["^22.23.4", "^24.22.1", ">=26.12.1"]
    cases = {
        "v22.23.4": True,
        "v22.30.0": True,
        "v22.12.0": False,
        "v23.5.0": False,
        "v24.22.1": True,
        "v24.10.0": False,
        "v26.12.1": True,
        "v27.0.0": True,
        "not-a-version": False,
    }
    for version, expected in cases.items():
        assert _node("m.nodeSatisfies(args[0], args[1])", version, ranges) is expected, (
            version
        )


def test_the_install_and_the_fuse_binary_are_both_audited():
    """On Linux REA's directory audit left every fuse `unknown`: the executable is audited too."""
    linux = _node("m.packagedTargets('linux', '/d', 'WorkPilot AI', 'workpilot-ai-ui')")
    windows = _node("m.packagedTargets('win32', '/d', 'WorkPilot AI', 'x')")
    mac = _node("m.packagedTargets('darwin', '/d', 'WorkPilot AI', 'x')")
    for targets in (linux, windows, mac):
        assert [t["label"] for t in targets] == ["install", "executable"]

    def names(targets, label):
        found = next(t for t in targets if t["label"] == label)["candidates"]
        return [p.replace("\\", "/") for p in found]

    assert names(linux, "install") == ["/d/linux-unpacked"]
    assert names(linux, "executable")[0] == "/d/linux-unpacked/workpilot-ai-ui"
    assert names(windows, "executable") == ["/d/win-unpacked/WorkPilot AI.exe"]
    assert all(p.endswith("WorkPilot AI.app") for p in names(mac, "install"))
    assert all(
        p.endswith("Electron Framework.framework/Versions/A/Electron Framework")
        for p in names(mac, "executable")
    )


def test_npx_is_found_next_to_node_without_a_shell():
    found = _node(
        "m.npxCli('/opt/node/bin/node', (p) => p.replace(/\\\\/g, '/') === "
        "'/opt/node/lib/node_modules/npm/bin/npx-cli.js')"
    )
    assert found.replace("\\", "/").endswith("lib/node_modules/npm/bin/npx-cli.js")
    assert _node("m.npxCli('/opt/node/bin/node', () => false)") is None


def test_the_report_is_read_inside_the_evidence_result():
    wrapped = json.dumps({"normalized_result": REPORT, "evidence": {}})
    report = _node("m.extractReport(args[0])", wrapped)
    assert [c["id"] for c in report["checks"]][1] == "electron.run_as_node"
    bare = _node("m.extractReport(args[0])", json.dumps(REPORT))
    assert bare["target"]["kind"] == "directory"


def test_output_without_checks_is_refused():
    for stdout in ("", "not json", json.dumps({"ok": True})):
        probe = (
            "(() => { try { m.extractReport(args[0]); return false }"
            " catch (e) { return e.message } })()"
        )
        assert _node(probe, stdout), stdout


def test_only_exposed_checks_at_the_threshold_block():
    high = _node("m.blockingChecks(args[0], 'high').map((c) => c.id)", REPORT)
    medium = _node("m.blockingChecks(args[0], 'medium').map((c) => c.id)", REPORT)
    low = _node("m.blockingChecks(args[0], 'low').map((c) => c.id)", REPORT)
    assert high == ["electron.run_as_node"]
    assert medium == ["electron.run_as_node", "electron.only_load_from_asar"]
    assert "packaging.extractable_payload" in low
    assert "electron.asar_integrity" not in low, "unknown never blocks"
    assert "native.hardening" not in low, "not_assessed never blocks"


def test_the_summary_lists_every_check_and_each_remediation():
    summary = _node("m.markdownSummary(args[0], 'high', 'linux-x64')", REPORT)
    for check in REPORT["checks"]:
        assert f"`{check['id']}`" in summary
    assert "fix electron.run_as_node" in summary
    assert "fix electron.asar_integrity" not in summary, "only exposed checks"


def test_arguments_are_closed():
    assert _node("m.parseArgs(['--packaged']).failOn") == "high"
    assert _node("m.parseArgs(['--packaged', '--fail-on', 'low']).failOn") == "low"
    for argv in (["--packaged", "--fail-on", "info"], ["--fail-on", "high"]):
        probe = (
            "(() => { try { m.parseArgs(args[0]); return null }"
            " catch (e) { return e.message } })()"
        )
        assert _node(probe, argv), argv


def test_electron_builder_flips_the_fuses_the_audit_checks():
    package = json.loads((FRONTEND / "package.json").read_text(encoding="utf-8"))
    fuses = package["build"]["electronFuses"]
    assert fuses["runAsNode"] is False
    assert fuses["enableNodeCliInspectArguments"] is False
    assert fuses["onlyLoadAppFromAsar"] is True
    assert fuses["enableEmbeddedAsarIntegrityValidation"] is True
    # Pages load from file:// (mainWindow.loadFile): keep its privileges.
    assert fuses.get("grantFileProtocolExtraPrivileges", True) is True
    # NODE_EXTRA_CA_CERTS rides on this fuse: corporate proxies need it.
    assert fuses.get("enableNodeOptionsEnvironmentVariable", True) is True


def test_dependency_source_maps_do_not_ship():
    """REA found 32 node_modules source maps in app.asar (javascript.source_maps, medium)."""
    package = json.loads((FRONTEND / "package.json").read_text(encoding="utf-8"))
    assert "!**/node_modules/**/*.map" in package["build"]["files"]


def test_every_packaged_app_is_audited_after_its_smoke_test():
    workflow = yaml.safe_load(RELEASE.read_text(encoding="utf-8"))
    audited = 0
    for job_name, job in workflow["jobs"].items():
        runs = [str(step.get("run", "")) for step in job.get("steps", [])]
        packaging = [i for i, r in enumerate(runs) if "pnpm run package:" in r]
        if not packaging:
            continue
        smoke = next(i for i, r in enumerate(runs) if "smoke-test.cjs --packaged" in r)
        audit = next(
            (i for i, r in enumerate(runs) if "release-exposure-audit.cjs" in r), None
        )
        assert audit is not None, f"{job_name} uploads an app nobody audited"
        assert audit > smoke > packaging[0], job_name
        assert "--packaged --fail-on high" in runs[audit], job_name
        uploads = [
            step
            for step in job["steps"]
            if "dist/release-exposure" in str(step.get("with", {}).get("path", ""))
        ]
        assert uploads and uploads[0].get("if") == "always()", (
            f"{job_name}: keep the report when the audit fails"
        )
        audited += 1
    assert audited == 4, "one audit per packaged platform"
