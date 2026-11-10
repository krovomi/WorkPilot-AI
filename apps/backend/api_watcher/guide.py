"""The migration guide of a comparison, in Markdown, without a model (#389).

One section per contract, breaking changes first, each with the action a
consumer takes, the consumers found and a deprecation timeline; the same text
serves the dashboard, the CLI (``GITHUB_STEP_SUMMARY``) and the PR body.
"""

from __future__ import annotations

from .breaking_change_detector import ChangeCategory, ContractChange
from .compare import CompareReport, ContractReport

_ACTIONS = {
    "endpoint_removed": "Stop calling it, or keep it served (deprecated) until consumers move.",
    "contract_removed": "Every consumer of this contract loses it: keep it until they move.",
    "field_removed": "Remove the field from client models, or keep it in the contract (deprecated).",
    "field_type_changed": "Update client models, parsing and validation to the new type.",
    "field_required_added": "Send the field from every client, or give it a default.",
    "field_number_changed": "Never renumber a protobuf field: restore the number, add a new field instead.",
    "parameter_added_required": "Send the parameter from every client, or make it optional.",
    "parameter_became_required": "Send the parameter from every client, or keep it optional.",
    "parameter_removed": "Stop sending it; servers that reject unknown parameters will fail.",
    "parameter_type_changed": "Update the type clients send.",
    "request_body_changed": "Update the request clients build.",
    "response_status_removed": "Update error handling that expects this status.",
    "response_type_changed": "Update the response model clients read.",
    "type_removed": "Replace the type in client code with its successor.",
    "enum_value_removed": "Handle the value disappearing; stored values may still hold it.",
    "enum_value_added": "Make sure exhaustive switches over the enum handle the new value.",
    "field_renamed": "Regenerate clients; JSON payloads use the new name.",
}

_MARK = {
    ChangeCategory.BREAKING: "🔴",
    ChangeCategory.POTENTIALLY_BREAKING: "🟡",
    ChangeCategory.NON_BREAKING: "🟢",
}


def _line(change: ContractChange, entry: ContractReport) -> list[str]:
    head = f"- {_MARK[change.category]} `{change.path}`: {change.description}"
    if change.old_value or change.new_value:
        head += f" (`{change.old_value or '∅'}` → `{change.new_value or '∅'}`)"
    if change.acknowledged:
        head += " — *acknowledged in the contract*"
    lines = [head]
    if change.category != ChangeCategory.NON_BREAKING:
        action = _ACTIONS.get(change.change_type.value)
        if action:
            lines.append(f"  - Action: {action}")
    for consumer in entry.consumers.get(change.path, [])[:6]:
        who = consumer["name"] + (
            f" ({consumer['contact']})" if consumer.get("contact") else ""
        )
        files = ", ".join(f"`{f}`" for f in consumer.get("files", [])[:3])
        lines.append(f"  - Consumer: {who}" + (f": {files}" if files else ""))
    return lines


def render(report: CompareReport, *, title: str = "API contract changes") -> str:
    if report.unchecked:
        return f"## {title}\n\nNot checked: {report.unchecked}.\n"
    if not report.contracts:
        return f"## {title}\n\nNo contract changed against `{report.target or report.base[:12]}`.\n"
    breaking = report.unacknowledged_breaking
    lines = [f"## {title}", ""]
    lines.append(
        f"Compared with `{report.target}` (merge base `{report.base[:12]}`): "
        + (
            f"**{len(breaking)} breaking change(s) not acknowledged.**"
            if breaking
            else "no unacknowledged breaking change."
        )
    )
    lines.append("")
    for entry in report.contracts:
        version = ""
        if entry.old_version or entry.new_version:
            version = f" ({entry.old_version or '∅'} → {entry.new_version or '∅'})"
        lines.append(f"### `{entry.path}` — {entry.format}, {entry.status}{version}")
        if entry.status == "unsupported":
            lines.append(
                f"Compared as text only (+{entry.text_delta[0]} / -{entry.text_delta[1]} lines): "
                "review it by hand."
            )
            lines.append("")
            continue
        ordered = sorted(
            entry.diff.changes,
            key=lambda c: (
                [
                    ChangeCategory.BREAKING,
                    ChangeCategory.POTENTIALLY_BREAKING,
                    ChangeCategory.NON_BREAKING,
                ].index(c.category),
                c.path,
            ),
        )
        for change in ordered:
            lines.extend(_line(change, entry))
        lines.append("")
    if breaking:
        lines += [
            "### Deprecation timeline",
            "",
            "1. Ship the new shape next to the old one (new field, new endpoint, `/v2`), the old one marked deprecated.",
            "2. Tell the consumers above and give them a release to move.",
            "3. Remove the old shape once no consumer calls it, with `x-breaking-acknowledged: true` on what is removed.",
            "",
        ]
    return "\n".join(lines)


def pr_section(spec_dir) -> str:
    """The PR body's section for the task's `api_contract.json`, or "".

    Lists each change that is not plain addition, with the consumers found;
    a consumer's ``contact`` written as ``@org/team`` notifies that team on
    GitHub and GitLab, which is how the people who use the API hear of it.
    """
    from .compare import load_record

    data = load_record(spec_dir)
    if not data or not data.get("contracts"):
        return ""
    lines = ["### 🔌 API contract changes", ""]
    unacked = int(data.get("unacknowledgedBreakingCount") or 0)
    lines.append(
        f"Compared with `{data.get('target') or 'the target branch'}`: "
        + (
            f"**{unacked} breaking change(s) not acknowledged.**"
            if unacked
            else "no unacknowledged breaking change."
        )
    )
    contacts: list[str] = []
    for contract in data["contracts"][:20]:
        changes = [
            c
            for c in contract.get("changes", [])
            if c.get("category") != "non_breaking"
        ]
        added = len(contract.get("changes", [])) - len(changes)
        lines.append("")
        lines.append(
            f"- `{contract.get('path')}` ({contract.get('format')}, {contract.get('status')})"
        )
        mark = {"breaking": "🔴", "potentially_breaking": "🟡"}
        for change in changes[:15]:
            note = " — acknowledged" if change.get("acknowledged") else ""
            lines.append(
                f"  - {mark.get(change.get('category'), '•')} `{change.get('path')}`{note}"
            )
            for consumer in change.get("consumers", [])[:4]:
                contact = str(consumer.get("contact") or "")
                if contact and contact not in contacts:
                    contacts.append(contact)
                lines.append(
                    f"    - used by {consumer.get('name')}"
                    + (f" ({contact})" if contact else "")
                )
        if added:
            lines.append(f"  - 🟢 {added} addition(s)")
    if contacts:
        lines += ["", "Consumers to tell: " + ", ".join(contacts[:10])]
    return "\n".join(lines) + "\n"
