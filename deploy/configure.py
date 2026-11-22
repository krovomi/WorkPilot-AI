#!/usr/bin/env python3
"""Prepare a WorkPilot multi-user server for where it runs.

Each team hosts its server where it can: a VPS or a Linux server with a
public name, a machine of the local network, or the operator's own computer
for a trial. This script asks which, then writes, next to it:

- ``.env.server``: the secrets (generated once, never replaced), the public
  address and the stream address that go with the choice;
- ``Caddyfile`` and ``docker-compose.override.yml``, copied from their
  examples: the proxy in front of the API and the live stream, HTTPS with a
  certificate Caddy obtains itself for a public name, plain HTTP otherwise.

Run it again to change the choice: the secrets stay, the address changes.

    cd deploy
    python3 configure.py                      # asks
    python3 configure.py --hosting public --host workpilot.example.com
    python3 configure.py --hosting lan --host 192.168.1.20
    python3 configure.py --hosting local

Standard library only, Python 3.10 or later: it runs on the host, before any
image is built. Guide: docs/server-operations.md
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import os
import re
import secrets
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent

#: The values this script owns in ``.env.server``; every other line is the
#: operator's and is kept as it stands.
ADDRESS_KEYS = (
    "WORKPILOT_HOSTING",
    "WORKPILOT_PUBLIC_BASE_URL",
    "WORKPILOT_PUBLIC_STREAM_URL",
)
#: Generated on the first run only: a new master key would make every token
#: stored on the server unreadable for good.
SECRET_KEYS = (
    "POSTGRES_PASSWORD",
    "WORKPILOT_JWT_SECRET",
    "WORKPILOT_SECRETS_MASTER_KEY",
)

_HOSTNAME = re.compile(
    r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$"
)


@dataclass(frozen=True)
class Hosting:
    key: str
    label: str
    scheme: str
    explanation: str


HOSTINGS: dict[str, Hosting] = {
    "public": Hosting(
        "public",
        "A VPS or a Linux server with a public DNS name",
        "https",
        "HTTPS with a Let's Encrypt certificate that Caddy obtains and renews "
        "itself. The name must point at this machine, ports 80 and 443 open.",
    ),
    "lan": Hosting(
        "lan",
        "A machine of the local network (company server, a team member's PC)",
        "http",
        "Plain HTTP on port 80, for a trusted network only: passwords and "
        "tokens cross it unencrypted. Your own certificate can be added later "
        "(see the guide).",
    ),
    "local": Hosting(
        "local",
        "This computer only, to try the server",
        "http",
        "Plain HTTP on http://localhost: only this computer reaches it.",
    ),
}


class ConfigError(ValueError):
    """An answer the script cannot build a configuration from."""


def normalize_host(hosting: Hosting, host: str) -> str:
    """The host name or address the server is reached at, checked.

    A public deployment needs a DNS name (Let's Encrypt issues no certificate
    for an IP address); a local one is always ``localhost``.
    """
    if hosting.key == "local":
        return "localhost"
    value = host.strip().lower().rstrip(".")
    bare = value[1:-1] if value.startswith("[") and value.endswith("]") else value
    if _is_ip(bare):
        if hosting.key == "public":
            raise ConfigError(
                "A public server needs a DNS name pointing at it: Let's Encrypt "
                "gives no certificate for an IP address. Use 'lan' for an address."
            )
        address = ipaddress.ip_address(bare)
        return f"[{address}]" if address.version == 6 else str(address)
    if any(mark in value for mark in ("://", "/", "@", ":")):
        raise ConfigError(
            "Give the host name or address only, without scheme, port or path"
        )
    if not _HOSTNAME.match(value):
        raise ConfigError(f"Not a host name: {host!r}")
    if hosting.key == "public" and "." not in value:
        raise ConfigError(
            "A public server needs a full DNS name, such as workpilot.example.com"
        )
    return value


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def addresses(hosting: Hosting, host: str) -> dict[str, str]:
    """The values of ``ADDRESS_KEYS`` for this choice."""
    stream = "wss" if hosting.scheme == "https" else "ws"
    return {
        "WORKPILOT_HOSTING": hosting.key,
        "WORKPILOT_PUBLIC_BASE_URL": f"{hosting.scheme}://{host}",
        # The proxy serves the stream on the same host (/stream/*).
        "WORKPILOT_PUBLIC_STREAM_URL": f"{stream}://{host}",
    }


def new_secrets() -> dict[str, str]:
    """Fresh values for ``SECRET_KEYS``. The PostgreSQL password is
    hexadecimal: it goes into the database URL as it is."""
    return {
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "WORKPILOT_JWT_SECRET": secrets.token_hex(32),
        "WORKPILOT_SECRETS_MASTER_KEY": base64.urlsafe_b64encode(
            secrets.token_bytes(32)
        ).decode(),
    }


def _value_of(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    return key.strip(), value.strip()


def render_env(template: str, existing: str | None, values: dict[str, str]) -> str:
    """``.env.server`` with ``values`` set.

    Starts from the operator's file when there is one (else the example), so
    every line they wrote stays; a secret already set is never replaced; a key
    the file lacks is added at its end.
    """
    lines = (existing if existing is not None else template).splitlines()
    current = {kv[0]: kv[1] for kv in map(_value_of, lines) if kv}
    wanted = dict(values)
    for key in SECRET_KEYS:
        if current.get(key):
            wanted.pop(key, None)
    out: list[str] = []
    for line in lines:
        kv = _value_of(line)
        commented = re.match(r"^#\s*([A-Z0-9_]+)=", line.strip())
        key = kv[0] if kv else (commented.group(1) if commented else None)
        if key in wanted:
            out.append(f"{key}={wanted.pop(key)}")
        else:
            out.append(line)
    if wanted:
        out.append("")
        out.append("# Written by deploy/configure.py")
        out.extend(f"{key}={value}" for key, value in wanted.items())
    return "\n".join(out) + "\n"


def write_private(path: Path, text: str) -> None:
    """Write ``text`` readable by its owner only (no-op on Windows' ACLs)."""
    path.write_text(text, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def copy_example(directory: Path, example: str, target: str) -> bool:
    """Copy an example next to it unless the operator already has a copy."""
    destination = directory / target
    if destination.exists():
        return False
    shutil.copyfile(directory / example, destination)
    return True


def configure(directory: Path, hosting_key: str, host: str) -> list[str]:
    """Write the configuration for ``hosting_key``; return what was done."""
    if hosting_key not in HOSTINGS:
        raise ConfigError(
            f"Unknown hosting: {hosting_key!r} (one of {', '.join(HOSTINGS)})"
        )
    hosting = HOSTINGS[hosting_key]
    name = normalize_host(hosting, host)
    env_path = directory / ".env.server"
    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else None
    template = (directory / "server-env.example").read_text(encoding="utf-8")
    values = {**new_secrets(), **addresses(hosting, name)}
    write_private(env_path, render_env(template, existing, values))
    done = [
        f"{'Updated' if existing is not None else 'Created'} .env.server "
        f"({hosting.key}, {addresses(hosting, name)['WORKPILOT_PUBLIC_BASE_URL']})"
    ]
    for example, target in (
        ("Caddyfile.example", "Caddyfile"),
        ("docker-compose.override.example.yml", "docker-compose.override.yml"),
    ):
        if copy_example(directory, example, target):
            done.append(f"Created {target} from {example}")
        else:
            done.append(f"Kept your {target}")
    return done


def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        raise ConfigError("No answer: pass --hosting and --host instead") from None


def ask_hosting() -> str:
    keys = list(HOSTINGS)
    print("Where does this WorkPilot server run?")
    for number, key in enumerate(keys, start=1):
        print(f"  {number}. {HOSTINGS[key].label}")
    answer = _ask("Choice [1]: ") or "1"
    if answer.isdigit() and 1 <= int(answer) <= len(keys):
        return keys[int(answer) - 1]
    if answer in HOSTINGS:
        return answer
    raise ConfigError(f"Not a choice: {answer!r}")


def ask_host(hosting: Hosting) -> str:
    if hosting.key == "local":
        return "localhost"
    if hosting.key == "public":
        return _ask("DNS name of the server (e.g. workpilot.example.com): ")
    return _ask(
        "Name or IP address of this machine on the network (e.g. 192.168.1.20): "
    )


def next_steps(hosting: Hosting, base_url: str) -> str:
    return "\n".join(
        [
            "",
            hosting.explanation,
            "",
            "Next:",
            "  1. Fill CLAUDE_CODE_OAUTH_TOKEN (or another provider's credentials) in .env.server",
            "  2. docker compose --env-file .env.server up -d --build",
            "  3. docker compose --env-file .env.server exec api \\",
            "       python -m server.scripts.create_admin you@example.com --name 'Your Name'",
            f"  4. In the desktop app: connect to {base_url}",
            "  5. Check that runs can be confined to their project (Landlock):",
            "       docker compose --env-file .env.server exec api python -c \\",
            "         'from foundation.landlock import abi_version; print(abi_version())'",
            "     A number = runs are isolated. An error = this kernel cannot, and every",
            "     run fails until the host can (see the guide before choosing otherwise).",
            "",
            "Guide: docs/server-operations.md",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--hosting", choices=list(HOSTINGS), help="where the server runs"
    )
    parser.add_argument("--host", default="", help="its DNS name or network address")
    parser.add_argument("--dir", type=Path, default=HERE, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        hosting_key = args.hosting or ask_hosting()
        hosting = HOSTINGS[hosting_key]
        host = args.host or ask_host(hosting)
        for line in configure(args.dir, hosting_key, host):
            print(line)
    except ConfigError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    base_url = addresses(hosting, normalize_host(hosting, host))[
        "WORKPILOT_PUBLIC_BASE_URL"
    ]
    print(next_steps(hosting, base_url))
    return 0


if __name__ == "__main__":
    sys.exit(main())
