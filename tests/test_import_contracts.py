"""Import contracts between the backend's top-level units.

A unit is a package or a module directly under ``apps/backend``. The audit of
17 October found no import contract at all, and one cycle holding 60 of the
126 units (81 by the time lot M10 started): ``core`` was both the low-level
toolbox every unit reads and the composition root that imports the agents, so
any unit wanting ``safe_error`` sat in the agents' cycle. Lot M10 took the
toolbox out (``foundation``, ``offline_policy``, ``app_detection``, the stack
detectors into ``project``) and the cycle down to 26 units: the agent runtime
itself (``core.client`` and ``agents.session`` with the phases built on them).
This test keeps it from growing back, and the units taken out of it that way.

The graph is read from the source with ``ast``, every ``import`` of the file
counted, including the ones inside a function: a lazy import is still a
dependency, it only moves the failure to run time. ``apps.backend.x`` counts as
``x``. Relative imports stay inside their unit and are ignored.

These contracts are written as a test rather than an ``import-linter``
configuration: the same check without a new dependency, and import-linter has
no contract for "this cycle may only shrink".
"""

from __future__ import annotations

import ast
from functools import cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
SKIPPED_DIRS = {"__pycache__", "tests", "node_modules"}

# What each unit may import from the rest of the backend, and nothing more.
# Widening an entry is a design change: say why in the PR.
ALLOWED_IMPORTS: dict[str, set[str]] = {
    # The lowest layer. api_safety reads the server settings when server mode
    # is installed, and server imports nothing back.
    "foundation": {"server"},
    # airgapStrict: the phase's model and the local runtimes, nothing above.
    "offline_policy": {"ollama_model_detector", "phase_config"},
    # The preview's project detector, read by verify and the Kanban runner.
    "app_detection": set(),
    # Stack detection, including the UI and test stacks moved here in M10.
    "project": {"mobile"},
    "mobile": {"foundation"},
    "rtk": {"foundation"},
    # Read by the scheduler and the phase config: its LLM refine takes the
    # client factory from its runner instead of importing core.
    "cost_intelligence": {"foundation", "models_registry", "phase_config"},
    # The security layer reads the project's stack (allowlist per stack), the
    # injection scanner, and rtk to see the command behind the proxy
    # (docs/architecture/rtk.md).
    "security": {"injection_guard", "project", "rtk"},
    # Server mode is mounted by provider_api; it reaches nothing back.
    "server": set(),
    # Model and provider per phase: the catalogue, the provider chosen in the
    # UI, and the complexity router.
    "phase_config": {"models_registry", "provider_selection", "scheduling"},
    "harness": {
        "agents",
        "context_mgmt",
        "core",
        "cost_intelligence",
        "docintel",
        "foundation",
        # The loop reports each measured model call as a GenAI span.
        "genai_trace",
        "security",
    },
    # GenAI spans: a leaf, read by the harness loop and the AgentClient base.
    "genai_trace": set(),
    # Read by core, phase_config and provider_api: a leaf, or the cycle it
    # was taken out of comes back.
    "provider_selection": set(),
    # The OS sandbox is read by core (client factory, tool executor, CLI
    # clients) and by the provider registry: a leaf, or it joins the cycle.
    # The card and the feed are written by core (`_report_sandbox`).
    "os_sandbox": {"foundation", "security"},
}

# The largest set of units that all import one another, directly or not. It
# may only shrink: lower the number when a change breaks a part of it.
MAX_CYCLE = 26


def _units() -> dict[str, Path]:
    units: dict[str, Path] = {}
    for entry in BACKEND.iterdir():
        if entry.name.startswith((".", "_")):
            continue
        if entry.is_dir() and entry.name not in SKIPPED_DIRS:
            if any(entry.rglob("*.py")):
                units[entry.name] = entry
        elif entry.suffix == ".py":
            units[entry.stem] = entry
    return units


def _files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return [
        f
        for f in path.rglob("*.py")
        if not SKIPPED_DIRS & set(f.relative_to(path).parts)
    ]


def _imported_units(file: Path, names: set[str]) -> set[str]:
    tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules = [node.module]
            if node.module == "apps.backend":
                modules = [alias.name for alias in node.names]
        else:
            continue
        for module in modules:
            module = module.removeprefix("apps.backend.")
            top = module.split(".")[0]
            if top in names:
                found.add(top)
    return found


@cache
def _graph() -> dict[str, frozenset[str]]:
    units = _units()
    names = set(units)
    graph: dict[str, frozenset[str]] = {}
    for name, path in units.items():
        edges: set[str] = set()
        for file in _files(path):
            edges |= _imported_units(file, names)
        edges.discard(name)
        graph[name] = frozenset(edges)
    return graph


def _largest_cycle(graph: dict[str, frozenset[str]]) -> set[str]:
    """The largest strongly connected component (iterative Tarjan)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    largest: set[str] = set()
    counter = 0
    for root in graph:
        if root in index:
            continue
        work = [(root, iter(sorted(graph[root])))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            child = next(children, None)
            if child is not None:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(sorted(graph[child]))))
                elif child in on_stack:
                    low[node] = min(low[node], index[child])
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component: set[str] = set()
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.add(member)
                    if member == node:
                        break
                if len(component) > len(largest):
                    largest = component
    return largest


def test_the_graph_is_read():
    graph = _graph()
    assert len(graph) > 100
    assert "core" in graph["agents"]


def test_each_contracted_unit_imports_only_what_it_may():
    graph = _graph()
    extra = {
        unit: sorted(graph[unit] - allowed)
        for unit, allowed in ALLOWED_IMPORTS.items()
        if graph[unit] - allowed
    }
    assert extra == {}, f"imports outside the contract: {extra}"


def test_the_contract_lists_no_import_that_is_gone():
    graph = _graph()
    stale = {
        unit: sorted(allowed - graph[unit])
        for unit, allowed in ALLOWED_IMPORTS.items()
        if allowed - graph[unit]
    }
    assert stale == {}, f"no longer imported, narrow ALLOWED_IMPORTS: {stale}"


def test_the_largest_cycle_does_not_grow():
    cycle = _largest_cycle(_graph())
    assert len(cycle) <= MAX_CYCLE, (
        f"{len(cycle)} units now import one another (limit {MAX_CYCLE}); "
        "the import that joined them is the one to move"
    )


def test_the_cycle_limit_follows_the_code_down():
    cycle = _largest_cycle(_graph())
    assert len(cycle) >= MAX_CYCLE, (
        f"the largest cycle is down to {len(cycle)} units: lower MAX_CYCLE"
    )


def test_cycle_detection_finds_a_cycle_and_ignores_a_chain():
    graph = {
        "a": frozenset({"b"}),
        "b": frozenset({"c"}),
        "c": frozenset({"a"}),
        "d": frozenset({"a"}),
    }
    assert _largest_cycle(graph) == {"a", "b", "c"}
    assert len(_largest_cycle({"x": frozenset({"y"}), "y": frozenset()})) == 1
