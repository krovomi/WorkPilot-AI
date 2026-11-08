"""runners/doc_drift_runner.py: real drift is reported, the usual noise is not."""

from __future__ import annotations

from pathlib import Path

from runners import doc_drift_runner as runner


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _refs(root: Path) -> set[str]:
    return {i["referencedSymbol"] for i in runner.run_scan(root)["issues"]}


def test_drift_in_every_language_is_reported(tmp_path):
    _write(
        tmp_path,
        "src/Orders/OrderService.cs",
        "public class OrderService\n{\n    public void Get(int id) { }\n}\n",
    )
    _write(
        tmp_path,
        "billing/invoice.go",
        "package billing\nfunc Refund(id string) error { return nil }\n",
    )
    _write(
        tmp_path,
        "README.md",
        "Call `OrderService.Get(` and `OrderService.Place(`, `Refund(` and `Charge(`.\n"
        "See `billing/invoice.go` and `billing/payments.go`.\n",
    )
    assert _refs(tmp_path) == {"OrderService.Place", "Charge", "billing/payments.go"}


def test_library_calls_the_code_uses_are_not_drift(tmp_path):
    _write(
        tmp_path,
        "web/app.ts",
        "import { useState } from 'react';\nconst [a] = useState(0);\n",
    )
    _write(tmp_path, "README.md", "State lives in `useState(` and `app.listen(`.\n")
    assert _refs(tmp_path) == {"app.listen"}


def test_paths_resolve_next_to_the_document_and_by_tail(tmp_path):
    _write(tmp_path, "packages/api/src/server.ts", "export function start() {}\n")
    _write(tmp_path, "packages/api/README.md", "Entry: `src/server.ts`.\n")
    _write(tmp_path, "docs/guide.md", "Server: `api/src/server.ts`.\n")
    assert _refs(tmp_path) == set()


def test_history_skills_generated_and_foreign_paths_are_ignored(tmp_path):
    _write(tmp_path, "src/a.py", "def a():\n    pass\n")
    _write(tmp_path, "CHANGELOG.md", "Removed `src/old.py` and `gone(`.\n")
    _write(tmp_path, "skills/x/SKILL.md", "Edit `src/routes/webhooks.ts`.\n")
    _write(
        tmp_path,
        "README.md",
        "Build to `dist/app.js`, copy `.env.example` to `config/.env.local`, "
        "see `/etc/hosts`, `~/x/y.md`, `src/*.py`, `other-repo/main.go`.\n",
    )
    assert _refs(tmp_path) == set()
