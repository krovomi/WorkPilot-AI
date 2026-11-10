"""The order of a release train: waves, cycles and what a rollback takes along.

A wave is a set of services whose dependencies all shipped in an earlier wave
(Kahn levels). Inside a wave the critical services go first, then by name, so
the same graph always gives the same order. A cycle stops the train: nothing
can go first, and the result names the services caught in it and the link
that, removed, would break it.

When a service fails after others shipped, ``cascade`` gives what goes back
with it: the service and every shipped service that depends on it, directly
or not, dependents first.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from .train_file import CRITICALITY


@dataclass
class TrainOrder:
    waves: list[list[str]] = field(default_factory=list)
    cycle: list[str] = field(default_factory=list)
    suggestion: tuple[str, str] | None = None
    unknown: dict[str, list[str]] = field(default_factory=dict)

    @property
    def order(self) -> list[str]:
        return [name for wave in self.waves for name in wave]

    def to_dict(self) -> dict[str, object]:
        return {
            "waves": self.waves,
            "cycle": self.cycle,
            "suggestion": list(self.suggestion) if self.suggestion else None,
            "unknown": self.unknown,
        }


def _find_cycle(left: Mapping[str, set[str]]) -> list[str]:
    """One cycle among the services Kahn could not place, in its order."""
    start = min(left)
    path: list[str] = []
    seen: dict[str, int] = {}
    node = start
    while node not in seen:
        seen[node] = len(path)
        path.append(node)
        node = min(dep for dep in left[node] if dep in left)
    return path[seen[node] :]


def plan_order(
    dependencies: Mapping[str, Iterable[str]],
    criticality: Mapping[str, str] | None = None,
) -> TrainOrder:
    """Waves for ``dependencies`` (service → the services it needs first)."""
    criticality = criticality or {}
    names = set(dependencies)
    needs: dict[str, set[str]] = {}
    unknown: dict[str, list[str]] = {}
    for name, deps in dependencies.items():
        deps = set(deps) - {name}
        missing = sorted(deps - names)
        if missing:
            unknown[name] = missing
        needs[name] = deps & names

    def rank(name: str) -> tuple[int, str]:
        return (CRITICALITY.get(criticality.get(name, "normal"), 1), name)

    order = TrainOrder(unknown=unknown)
    placed: set[str] = set()
    left = dict(needs)
    while left:
        wave = sorted((n for n, deps in left.items() if deps <= placed), key=rank)
        if not wave:
            cycle = _find_cycle(left)
            order.cycle = cycle
            # The link from the least critical service of the cycle to the
            # next one is the one a person most likely can do without.
            weakest = max(range(len(cycle)), key=lambda i: rank(cycle[i]))
            order.suggestion = (cycle[weakest], cycle[(weakest + 1) % len(cycle)])
            return order
        order.waves.append(wave)
        placed.update(wave)
        for name in wave:
            del left[name]
    return order


def dependents(dependencies: Mapping[str, Iterable[str]], service: str) -> set[str]:
    """Every service that needs ``service``, directly or through another."""
    found: set[str] = set()
    frontier = [service]
    while frontier:
        current = frontier.pop()
        for name, deps in dependencies.items():
            if current in deps and name not in found and name != service:
                found.add(name)
                frontier.append(name)
    return found


def cascade(
    dependencies: Mapping[str, Iterable[str]],
    service: str,
    shipped: Iterable[str],
    order: list[str],
) -> list[str]:
    """What rolls back with ``service``, in the order to roll it back.

    The shipped dependents first (latest shipped first), ``service`` last, so a
    service never runs against a dependency older than the one it was built for.
    """
    shipped = set(shipped)
    taken = (dependents(dependencies, service) & shipped) | {service}
    position = {name: index for index, name in enumerate(order)}
    return sorted(taken, key=lambda n: position.get(n, -1), reverse=True)


__all__ = ["TrainOrder", "cascade", "dependents", "plan_order"]
