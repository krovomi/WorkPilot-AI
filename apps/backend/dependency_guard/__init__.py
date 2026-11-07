"""Dependency guard: a package the task added must exist on its registry.

Agents invent package names (*slopsquatting*: Spracklen et al., USENIX
Security 2025, at least 5.2 % of the packages suggested by commercial models
and 21.7 % by open models do not exist), and an attacker who publishes one of
those names gets their code installed. The guard reads the manifests the task
changed, for every stack WorkPilot builds, keeps the packages added since the
merge base, and asks each public registry about them.

Only a 404 from the public registry, for a project with no other source for
that ecosystem, blocks. A registry that did not answer, strict offline mode or
a private feed give ``unknown``, which never blocks and never counts as a pass.
See docs/architecture/dependency-guard.md.
"""

from .guard import (
    BLOCKED,
    OK,
    RECORD_FILE,
    UNKNOWN,
    WARN,
    Added,
    Finding,
    GuardReport,
    added_packages,
    check,
    display_name,
    load_record,
    write_record,
)
from .manifests import Package, is_manifest, parse_manifest
from .registries import FOUND, NOT_FOUND, UNREACHABLE, http_fetch, lookup

__all__ = [
    "BLOCKED",
    "FOUND",
    "NOT_FOUND",
    "OK",
    "RECORD_FILE",
    "UNKNOWN",
    "UNREACHABLE",
    "WARN",
    "Added",
    "Finding",
    "GuardReport",
    "Package",
    "added_packages",
    "check",
    "display_name",
    "http_fetch",
    "is_manifest",
    "load_record",
    "lookup",
    "parse_manifest",
    "write_record",
]
