"""Which hosts a sandboxed process may reach, through the filtering proxy.

A host is allowed when it matches one entry exactly or, for an entry written
``*.example.com``, when it is a subdomain of ``example.com`` (never
``example.com`` itself, never ``badexample.com``). A port is part of the
entry only for a loopback endpoint (``127.0.0.1:11434``): a remote entry
allows ports 443 and 80, nothing else.

Nothing here comes from the model or from a repository: the lists are this
module's, the provider's entry in ``capabilities/providers.yaml`` and the
person's ``WORKPILOT_SANDBOX_HOSTS``.
"""

from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urlsplit

#: Added by the person, comma separated, to every sandboxed process.
EXTRA_HOSTS_ENV = "WORKPILOT_SANDBOX_HOSTS"

#: The package registries a build installs from. Mirrors and private feeds
#: are the person's to add (`WORKPILOT_SANDBOX_HOSTS`).
PACKAGE_REGISTRIES: tuple[str, ...] = (
    # npm, pnpm, yarn
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    # pip, uv
    "pypi.org",
    "files.pythonhosted.org",
    # NuGet
    "api.nuget.org",
    "globalcdn.nuget.org",
    # Cargo
    "index.crates.io",
    "static.crates.io",
    "crates.io",
    # Go
    "proxy.golang.org",
    "sum.golang.org",
    # Maven, Gradle
    "repo.maven.apache.org",
    "repo1.maven.org",
    "plugins.gradle.org",
    # RubyGems
    "rubygems.org",
    "index.rubygems.org",
)

#: Remote ports an entry without a port allows.
REMOTE_PORTS = frozenset({80, 443})

_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")


@dataclass(frozen=True)
class HostRule:
    host: str
    wildcard: bool = False
    port: int | None = None

    def allows(self, host: str, port: int) -> bool:
        if self.port is not None:
            return port == self.port and host == self.host
        if port not in REMOTE_PORTS:
            return False
        if self.wildcard:
            return host.endswith("." + self.host)
        return host == self.host


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_host(host: str) -> str | None:
    """A host name as compared, or None when it is not one."""
    host = host.strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if not host or len(host) > 253:
        return None
    if not all(_LABEL.match(label) for label in host.split(".")):
        return None
    return host


def parse_rule(entry: str) -> HostRule | None:
    """One allowlist entry, or None when it is not a valid one."""
    entry = entry.strip().lower()
    if not entry:
        return None
    wildcard = entry.startswith("*.")
    if wildcard:
        entry = entry[2:]
    host, port = entry, None
    if entry.count(":") == 1:
        host, _, raw_port = entry.partition(":")
        if not raw_port.isdigit() or not 0 < int(raw_port) < 65536:
            return None
        port = int(raw_port)
    normalized = normalize_host(host)
    if normalized is None:
        return None
    if port is not None and (wildcard or not _is_loopback(normalized)):
        # A port names a local endpoint; a remote one is 443/80.
        return None
    if _is_loopback(normalized) and port is None:
        # Loopback without a port would open every local service.
        return None
    if wildcard and normalized.count(".") < 1:
        # `*.com` is not an allowlist.
        return None
    return HostRule(normalized, wildcard, port)


def loopback_rule(url: str) -> str | None:
    """The allowlist entry for a local endpoint URL (``http://127.0.0.1:11434``)."""
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if not _is_loopback(host):
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return f"{host}:{port}"


@dataclass(frozen=True)
class HostAllowlist:
    rules: tuple[HostRule, ...]

    @classmethod
    def build(cls, *groups: Iterable[str]) -> HostAllowlist:
        rules: list[HostRule] = []
        for group in groups:
            for entry in group:
                rule = parse_rule(entry)
                if rule is not None and rule not in rules:
                    rules.append(rule)
        return cls(tuple(rules))

    def allows(self, host: str, port: int) -> bool:
        normalized = normalize_host(host)
        if normalized is None:
            return False
        return any(rule.allows(normalized, port) for rule in self.rules)

    def describe(self) -> list[str]:
        return [
            ("*." if rule.wildcard else "")
            + rule.host
            + (f":{rule.port}" if rule.port else "")
            for rule in self.rules
        ]


def extra_hosts() -> list[str]:
    return [
        entry
        for entry in os.environ.get(EXTRA_HOSTS_ENV, "").split(",")
        if entry.strip()
    ]


def allowlist_for(provider_hosts: Iterable[str] = ()) -> HostAllowlist:
    """The registries, the provider's own hosts, and the person's additions."""
    return HostAllowlist.build(PACKAGE_REGISTRIES, provider_hosts, extra_hosts())
