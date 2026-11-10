"""Who consumes a contract, so a breaking change reaches the right people (#389).

Two sources, both read-only:

- the registry the person writes, ``.workpilot/api-consumers.yaml`` (or
  ``.json``) in the main checkout::

      consumers:
        - name: Mobile app
          contact: "@acme/mobile"        # a GitHub/GitLab team, an email…
          contracts: ["api/orders.yaml"] # fnmatch patterns, repo-relative
          paths: ["apps/mobile/**"]      # where its code lives, if in this repo

- the repository itself: the code files that quote a broken endpoint's path,
  operation id or rpc name (every stack: the search is a literal one over
  source files). Each file is grouped under the registry entry whose
  ``paths`` match it, else under its top-level folder (a service of the
  monorepo).

The registry is data: it is read with ``yaml.safe_load``, each value is
checked and bounded, and a contact is only ever shown, never contacted.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .discover import EXCLUDED_DIRS

REGISTRY_NAMES = (
    Path(".workpilot") / "api-consumers.yaml",
    Path(".workpilot") / "api-consumers.yml",
    Path(".workpilot") / "api-consumers.json",
)
MAX_CONSUMERS = 100
MAX_FILES = 5000
MAX_FILE_BYTES = 512 * 1024
MAX_REFERENCES = 20
_WHOLE = "\x00"  # needle suffix: the literal ends the path

#: Source files of every stack the reference search reads.
CODE_SUFFIXES = frozenset(
    {
        ".cs", ".fs", ".vb", ".razor", ".cshtml",
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
        ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".groovy",
        ".php", ".rb", ".swift", ".m", ".dart", ".ex", ".exs", ".erl",
        ".c", ".cc", ".cpp", ".h", ".hpp", ".lua", ".r", ".jl",
        ".html", ".graphql", ".gql",
    }
)  # fmt: skip


@dataclass(frozen=True)
class Consumer:
    name: str
    contact: str = ""
    contracts: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()

    def uses(self, contract: str) -> bool:
        return any(fnmatch.fnmatchcase(contract, p) for p in self.contracts)

    def owns(self, path: str) -> bool:
        return any(fnmatch.fnmatchcase(path, p) for p in self.paths)

    def to_dict(self) -> dict:
        return {"name": self.name, "contact": self.contact}


@dataclass
class Registry:
    consumers: list[Consumer] = field(default_factory=list)
    source: str = ""
    errors: list[str] = field(default_factory=list)


def _strings(value: object, limit: int = 50) -> tuple[str, ...]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return ()
    return tuple(
        str(v).strip()[:200] for v in value[:limit] if isinstance(v, str) and v.strip()
    )


def parse_registry(raw: object) -> tuple[list[Consumer], list[str]]:
    entries = raw.get("consumers") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return [], ["the registry has no 'consumers' list"] if raw else []
    consumers: list[Consumer] = []
    errors: list[str] = []
    for index, entry in enumerate(entries[:MAX_CONSUMERS]):
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            errors.append(f"entry {index + 1} has no name")
            continue
        consumers.append(
            Consumer(
                name=entry["name"].strip()[:120],
                contact=str(entry.get("contact") or "").strip()[:200],
                contracts=_strings(entry.get("contracts")),
                paths=_strings(entry.get("paths")),
            )
        )
    return consumers, errors


def load_registry(root: Path) -> Registry:
    """The registry of the main checkout of ``root`` (a task runs in a worktree)."""
    from security.guardrail_policy import main_project

    base = main_project(Path(root))
    for name in REGISTRY_NAMES:
        path = base / name
        if path.is_symlink() or not path.is_file():
            continue
        import yaml

        try:
            text = path.read_text(encoding="utf-8")[:MAX_FILE_BYTES]
            raw = json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)
        except (OSError, ValueError, yaml.YAMLError) as exc:
            return Registry(
                source=name.as_posix(), errors=[f"unreadable: {type(exc).__name__}"]
            )
        consumers, errors = parse_registry(raw)
        return Registry(consumers, name.as_posix(), errors)
    return Registry()


def needles_for(change_path: str, operation_ids: dict[str, str]) -> list[str]:
    """The literal strings a client of ``change_path`` would contain: the
    static part of an HTTP path (``/orders/``), an operation id, an rpc or a
    GraphQL root field name. Field-level changes give none: a field name is
    too common a word to mean a client."""
    endpoint = change_path.split(".params.", 1)[0].split(".responses.", 1)[0]
    endpoint = endpoint.split(".body", 1)[0]
    method, _, target = endpoint.partition(" ")
    needles: list[str] = []
    if (
        method in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
        and target
    ):
        static = re.split(r"[{:<]", target, maxsplit=1)[0]
        if len(static.strip("/")) >= 3:
            # A whole path (`/orders`) must end there: `/orders/1` is another.
            needles.append(static if static != target else static + _WHOLE)
        op = operation_ids.get(endpoint)
        if op and len(op) >= 4:
            needles.append(op)
    elif method == "RPC" and "/" in target:
        name = target.rsplit("/", 1)[-1]
        if len(name) >= 4:
            needles.append(name)
    elif method in {"QUERY", "MUTATION", "SUBSCRIPTION"} and len(target) >= 4:
        needles.append(target)
    return needles


def _code_files(root: Path, skip: set[str]):
    count = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith(".")]
        for name in files:
            if Path(name).suffix.lower() not in CODE_SUFFIXES:
                continue
            path = Path(current) / name
            rel = path.relative_to(root).as_posix()
            if rel in skip or path.is_symlink():
                continue
            count += 1
            if count > MAX_FILES:
                return
            yield rel, path


def _pattern(needle: str) -> re.Pattern:
    if needle.endswith(_WHOLE):
        return re.compile(r"(?<![\w/])" + re.escape(needle[:-1]) + r"(?![\w/{$])")
    return re.compile(r"(?<![\w/])" + re.escape(needle) + r"(?!\w)")


def find_references(
    root: Path, needles: dict[str, list[str]], skip: set[str]
) -> dict[str, list[str]]:
    """For each change path, the code files that quote one of its needles."""
    found: dict[str, list[str]] = {key: [] for key in needles}
    patterns = {
        key: [_pattern(n) for n in values] for key, values in needles.items() if values
    }
    if not patterns:
        return found
    for rel, path in _code_files(Path(root), skip):
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for key, compiled in patterns.items():
            if len(found[key]) < MAX_REFERENCES and any(
                p.search(text) for p in compiled
            ):
                found[key].append(rel)
    return found


def group(files: list[str], contract: str, registry: Registry) -> list[dict]:
    """The consumers concerned: registry entries that declare the contract or
    own a referencing file, then the top-level folders of the other files."""
    out: list[dict] = []
    named: set[str] = set()
    for consumer in registry.consumers:
        mine = [f for f in files if consumer.owns(f)]
        if consumer.uses(contract) or mine:
            out.append({**consumer.to_dict(), "files": mine[:MAX_REFERENCES]})
            named.update(mine)
    by_folder: dict[str, list[str]] = {}
    for f in files:
        if f in named:
            continue
        top = f.split("/", 1)[0] if "/" in f else "."
        by_folder.setdefault(top, []).append(f)
    for folder, mine in sorted(by_folder.items()):
        out.append({"name": folder, "contact": "", "files": mine[:MAX_REFERENCES]})
    return out
