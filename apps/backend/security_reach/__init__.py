"""The evidence that ranks a security scan's findings (issue #364).

``evidence_for(project_dir, findings)`` says, for each finding, whether the
project's entry points reach its code, whether production ran it in the last
30 days, how many users that touched, and whether a dependency is transitive.
``security.finding_priority`` turns that into a priority and a section.

No model, no network, no new dependency: text read from the project and the
APM payloads already in its inbox, so the same for every language, stack and
provider. Wired by the QA loop (``qa.loop._run_security_scan``).
"""

from __future__ import annotations

from pathlib import Path

from security.finding_priority import Evidence, PriorityContext, Reach
from security.vulnerability_scanner import Vulnerability

from .dependencies import declared_packages, dependency_name, is_imported, normalize
from .graph import ReachGraph, build_graph
from .runtime import WINDOW_DAYS, RuntimeEvidence, read_runtime
from .sources import Sources, is_test_path, read_sources

__all__ = ["evidence_for"]

RUNTIME_OFF_NOTE = (
    f"Runtime correlation is off: no production incident in .workpilot/incidents/ "
    f"in the last {WINDOW_DAYS} days. Drop your monitoring tool's payloads there "
    "(Sentry, Datadog, CloudWatch, New Relic…) to rank findings by what runs in "
    "production; until then, reachability alone ranks them."
)
NO_ENTRY_NOTE = (
    "No entry point (main, route, handler, command) was found: reachability is "
    "unknown and no finding is moved down."
)
TRUNCATED_NOTE = (
    "The project is large: only its first files were read for reachability."
)


def _file_reach(rel: str, graph: ReachGraph, sources: Sources) -> tuple[Reach, bool]:
    if rel not in sources.files:
        return (Reach.TEST if is_test_path(rel) else Reach.UNKNOWN), False
    if rel in graph.tests:
        return Reach.TEST, False
    if not graph.entries:
        return Reach.UNKNOWN, False
    if graph.is_reached(rel):
        return Reach.REACHED, False
    if graph.dynamic:
        return Reach.UNCERTAIN, True
    return Reach.UNREACHED, False


def _dependency_evidence(
    name: str,
    graph: ReachGraph,
    declared: set[str],
    runtime: RuntimeEvidence,
) -> Evidence:
    key = normalize(name)
    transitive = key not in declared
    importers = [
        rel for rel, text in graph.import_text.items() if is_imported(name, text)
    ]
    dynamic = False
    if transitive or not importers:
        # A dependency pulled in by another one, or imported under another
        # name than its package's (PyYAML is ``import yaml``): it may run.
        reach = Reach.UNCERTAIN
    elif not graph.entries:
        reach = Reach.UNKNOWN
    elif any(rel in graph.reached for rel in importers):
        reach = Reach.REACHED
    elif all(rel in graph.tests for rel in importers):
        reach = Reach.TEST
    elif graph.dynamic:
        reach, dynamic = Reach.UNCERTAIN, True
    else:
        reach = Reach.UNREACHED
    return Evidence(
        reach=reach,
        runtime_hits=runtime.package_hits.get(key, 0),
        users=runtime.package_users.get(key, 0),
        transitive=transitive,
        dynamic=dynamic,
    )


def _relative(file: str, root: Path) -> str:
    path = Path(file)
    if path.is_absolute():
        try:
            return path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            return path.as_posix()
    return path.as_posix().removeprefix("./")


def evidence_for(project_dir: object, findings: list[Vulnerability]) -> PriorityContext:
    root = Path(str(project_dir))
    sources = read_sources(root)
    graph = build_graph(sources)
    runtime = read_runtime(root, set(sources.files))
    declared = declared_packages(sources.manifests)

    context = PriorityContext(
        runtime_available=runtime.available, entry_points=len(graph.entries)
    )
    if not runtime.available:
        context.notes.append(RUNTIME_OFF_NOTE)
    if not graph.entries:
        context.notes.append(NO_ENTRY_NOTE)
    if sources.truncated:
        context.notes.append(TRUNCATED_NOTE)

    for finding in findings:
        name = dependency_name(finding.dependency)
        if name:
            context.evidence.append(
                _dependency_evidence(name, graph, declared, runtime)
            )
            continue
        if not finding.file:
            context.evidence.append(Evidence())
            continue
        rel = _relative(finding.file, root)
        reach, dynamic = _file_reach(rel, graph, sources)
        context.evidence.append(
            Evidence(
                reach=reach,
                runtime_hits=runtime.file_hits.get(rel, 0),
                users=runtime.file_users.get(rel, 0),
                dynamic=dynamic,
            )
        )
    return context
