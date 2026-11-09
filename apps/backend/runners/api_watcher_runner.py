"""
API Watcher Runner

Scans a project for API contract specifications (OpenAPI, GraphQL, Protobuf)
and compares each one with the target branch (`api_watcher.compare`, #389):
the merge base of HEAD and ``--target`` (detected when empty), every contract
on its own, with the consumers that use what broke and a migration guide.

``--mode baseline`` (or a project that is not a git repository) keeps the
older comparison with a saved baseline, `.workpilot/api-contract-baseline.json`:
when absent, the runner saves the current contracts and returns an empty diff.

Output protocol (one JSON object per line, prefixed):
    API_WATCHER_EVENT:{"type": "progress", "data": {"status": "..."}}
    API_WATCHER_RESULT:{...diff dict...}
    API_WATCHER_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from api_watcher.breaking_change_detector import (  # noqa: E402
    BreakingChangeDetector,
    ChangeCategory,
    ContractDiff,
)
from api_watcher.contract_parser import (  # noqa: E402
    ApiContract,
    ContractFormat,
    ContractParser,
)
from api_watcher.discover import discover  # noqa: E402
from api_watcher.migration_guide_generator import (  # noqa: E402
    MigrationGuideGenerator,
)


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("API_WATCHER_EVENT", {"type": event_type, "data": data})


def _discover_specs(project_path: Path) -> list[Path]:
    """Every contract file, dependency and build folders pruned on the way."""
    root = project_path.resolve()
    return [root / rel for rel in discover(root)]


def _contract_to_dict(contract: ApiContract) -> dict[str, Any]:
    return {
        "title": contract.title,
        "version": contract.version,
        "format": contract.format.value,
        "endpoints": [
            {
                "path": ep.path,
                "method": ep.method,
                "operationId": ep.operation_id,
                "deprecated": ep.deprecated,
                "parameters": [asdict(p) for p in ep.parameters],
            }
            for ep in contract.endpoints
        ],
        "types": {
            name: [asdict(f) for f in fields] for name, fields in contract.types.items()
        },
    }


def _dict_to_contract(data: dict[str, Any]) -> ApiContract:
    from api_watcher.contract_parser import ApiEndpoint, ApiField

    fmt = ContractFormat(data.get("format", "unknown"))
    contract = ApiContract(
        title=data.get("title", ""),
        version=data.get("version", ""),
        format=fmt,
    )
    for ep in data.get("endpoints", []):
        contract.endpoints.append(
            ApiEndpoint(
                path=ep.get("path", ""),
                method=ep.get("method", ""),
                operation_id=ep.get("operationId", ""),
                deprecated=ep.get("deprecated", False),
                parameters=[ApiField(**p) for p in ep.get("parameters", [])],
            )
        )
    for name, fields in data.get("types", {}).items():
        contract.types[name] = [ApiField(**f) for f in fields]
    return contract


def _change_to_dict(change: Any) -> dict[str, Any]:
    return {
        "changeType": change.change_type.value,
        "category": _category_to_ui(change.category),
        "path": change.path,
        "description": change.description,
        "oldValue": change.old_value,
        "newValue": change.new_value,
    }


def _category_to_ui(category: ChangeCategory) -> str:
    mapping = {
        ChangeCategory.BREAKING: "breaking",
        ChangeCategory.POTENTIALLY_BREAKING: "potentially_breaking",
        ChangeCategory.NON_BREAKING: "non_breaking",
    }
    return mapping.get(category, "non_breaking")


def _diff_to_dict(
    diff: ContractDiff, fmt: ContractFormat, old_v: str, new_v: str
) -> dict[str, Any]:
    return {
        "oldVersion": old_v,
        "newVersion": new_v,
        "format": fmt.value,
        "changes": [_change_to_dict(c) for c in diff.changes],
        "breakingCount": diff.breaking_count,
        "potentiallyBreakingCount": diff.potentially_breaking_count,
        "nonBreakingCount": diff.non_breaking_count,
    }


def _empty_diff(fmt: ContractFormat = ContractFormat.UNKNOWN) -> dict[str, Any]:
    return {
        "oldVersion": "",
        "newVersion": "",
        "format": fmt.value,
        "changes": [],
        "breakingCount": 0,
        "potentiallyBreakingCount": 0,
        "nonBreakingCount": 0,
    }


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering API specifications..."})
    specs = _discover_specs(project_path)

    if not specs:
        _emit_event("complete", {"status": "No API specs found"})
        return {
            "diff": _empty_diff(),
            "migrationGuideMarkdown": "",
            "summary": "No API contract specifications found in project",
        }

    _emit_event("progress", {"status": f"Found {len(specs)} spec file(s)"})

    parser = ContractParser()
    current_contracts: dict[str, dict[str, Any]] = {}
    primary_contract: ApiContract | None = None
    primary_key: str | None = None

    for spec in specs:
        try:
            contract = parser.parse_file(spec)
            if contract.format == ContractFormat.UNKNOWN:
                continue
            rel_key = str(spec.relative_to(project_path))
            current_contracts[rel_key] = _contract_to_dict(contract)
            if primary_contract is None:
                primary_contract = contract
                primary_key = rel_key
        except (OSError, ValueError) as exc:
            _emit_event("progress", {"status": f"Failed to parse {spec.name}: {exc}"})

    if not current_contracts or primary_contract is None:
        _emit_event("complete", {"status": "No parseable specs"})
        return {
            "diff": _empty_diff(),
            "migrationGuideMarkdown": "",
            "summary": "Found spec files but none could be parsed",
        }

    baseline_path = project_path / ".workpilot" / "api-contract-baseline.json"
    if not baseline_path.exists():
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps(current_contracts, indent=2), encoding="utf-8"
        )
        _emit_event("complete", {"status": "Baseline saved"})
        return {
            "diff": _empty_diff(primary_contract.format),
            "migrationGuideMarkdown": "",
            "summary": (
                f"Baseline saved ({len(current_contracts)} contract(s)). "
                "Re-run after modifying specs to detect breaking changes."
            ),
        }

    try:
        baseline_data = json.loads(baseline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "diff": _empty_diff(),
            "migrationGuideMarkdown": "",
            "summary": f"Failed to read baseline: {exc}",
        }

    _emit_event("progress", {"status": "Diffing against baseline..."})

    detector = BreakingChangeDetector()
    old_contract_data = baseline_data.get(primary_key)
    if old_contract_data is None:
        first_key = next(iter(baseline_data))
        old_contract_data = baseline_data[first_key]

    old_contract = _dict_to_contract(old_contract_data)
    diff = detector.diff(old_contract, primary_contract)

    generator = MigrationGuideGenerator()
    guide = generator.generate(
        diff,
        from_version=old_contract.version or "baseline",
        to_version=primary_contract.version or "current",
    )

    _emit_event(
        "complete",
        {
            "breaking": diff.breaking_count,
            "potentiallyBreaking": diff.potentially_breaking_count,
            "nonBreaking": diff.non_breaking_count,
        },
    )

    return {
        "diff": _diff_to_dict(
            diff,
            primary_contract.format,
            old_contract.version or "baseline",
            primary_contract.version or "current",
        ),
        "migrationGuideMarkdown": guide.markdown,
        "summary": diff.summary,
    }


def run_branch(project_path: Path, target: str = "") -> dict[str, Any] | None:
    """The comparison with the target branch, or None when there is no git
    history to compare with (the caller falls back to the baseline)."""
    from api_watcher.ci import github_actions
    from api_watcher.compare import compare
    from api_watcher.guide import render

    _emit_event("start", {"status": "Comparing contracts with the target branch..."})
    report = compare(project_path, target=target)
    if report.unchecked and not target:
        return None
    data = report.to_dict()
    changes = [c for contract in data["contracts"] for c in contract["changes"]]
    _emit_event(
        "complete",
        {
            "breaking": data["breakingCount"],
            "potentiallyBreaking": data["potentiallyBreakingCount"],
            "nonBreaking": data["nonBreakingCount"],
        },
    )
    return {
        "mode": "branch",
        "report": data,
        "diff": {
            "oldVersion": report.target,
            "newVersion": "HEAD",
            "format": data["contracts"][0]["format"]
            if data["contracts"]
            else "unknown",
            "changes": changes,
            "breakingCount": data["breakingCount"],
            "potentiallyBreakingCount": data["potentiallyBreakingCount"],
            "nonBreakingCount": data["nonBreakingCount"],
        },
        "migrationGuideMarkdown": render(report) if data["contracts"] else "",
        "ciWorkflow": github_actions(
            discover(project_path), report.target or "develop"
        ),
        "summary": (
            f"Not compared: {report.unchecked}"
            if report.unchecked
            else f"{len(data['contracts'])} contract(s) changed against {report.target}"
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="API Watcher Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--save-baseline",
        action="store_true",
        help="Force overwrite baseline with current contracts",
    )
    parser.add_argument(
        "--mode",
        choices=("branch", "baseline"),
        default="branch",
        help="what to compare with",
    )
    parser.add_argument(
        "--target", default="", help="target branch (default: detected)"
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("API_WATCHER_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    if args.save_baseline:
        baseline = project_path / ".workpilot" / "api-contract-baseline.json"
        if baseline.exists():
            baseline.unlink()

    try:
        result = None
        if args.mode == "branch" and not args.save_baseline:
            result = run_branch(project_path, args.target)
        if result is None:
            result = {"mode": "baseline", **run_scan(project_path)}
        _emit("API_WATCHER_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("API_WATCHER_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
