"""The keys whose signed commits a project's memory trusts (#352).

A teammate's note reaches this machine through git: whoever can push to the
vault's remote can put a note there, and an agent would read it as the
team's knowledge. A team that wants more than "trust the remote" lists the
signing keys its members already use for git (SSH or GPG commit signing; no
new key to manage), next to its maintainers:

    knowledge/projects/<project>/memory/.lifecycle/trusted-signers.md

    - alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI…
    - bob@example.com 3AA5C34371567BD2F2C9B5E0A1D3C4E5F6A7B8C9

A line is a name (an e-mail or a git name, one word) and a key: an SSH public
key (``<type> <base64>``, a trailing comment is dropped) or a GPG
fingerprint (40 or 64 hexadecimal digits, spaces allowed). The notes are
then judged by `provenance.py`; this module only reads, checks and writes the
list. No list, or an empty one, changes nothing: every note is trusted as
before.

Who edits it follows the maintainers' model (`maintainers.py`): the list is
edited from the Lifecycle tab, journalled (``designate``,
``signers-changed``), and when the project has maintainers, only they edit
it. That is the local rule; the one that holds on a teammate's machine is
cryptographic: a change to the list that someone else pushed counts only
when a key already on the list signed it (`provenance.effective`).

The notes outside every project (vault-wide knowledge, shared instructions,
agents' snapshots, skills) have the vault's own list, `VAULT_LIST`, in the
same format and under the same cryptographic rule. The vault has no
maintainers, so it is edited where the vault's other settings are (Settings
→ Brain, `write_vault`), and its history is the vault's git log: a project's
journal is not the place of a decision that covers every project.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import struct
from dataclasses import dataclass
from pathlib import Path

from ..notes import inside
from .journal import LIFECYCLE_DIR, JournalEntry, append

__all__ = [
    "FILE",
    "MAX_SIGNERS",
    "VAULT_LIST",
    "Signer",
    "clean",
    "list_rel",
    "parse",
    "parse_line",
    "render",
    "write",
    "write_vault",
]

FILE = "trusted-signers.md"
VAULT_LIST = f"knowledge/{LIFECYCLE_DIR}/{FILE}"
"""The vault's list, for the notes outside every project's folder."""
MAX_SIGNERS = 50
_MAX_LINE = 1200
"""An RSA-4096 public key is about 730 characters."""
_NAME = re.compile(r"[^\s,*?!\"\\]{1,120}")
"""One word: git's ``allowed_signers`` reads ``*``, ``?``, ``!`` and ``,`` as
patterns, and a name must never match more than the person it names."""
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_HEX = re.compile(r"(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})")
SSH_TYPES = frozenset(
    {
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ssh-ed25519@openssh.com",
        "sk-ecdsa-sha2-nistp256@openssh.com",
    }
)
_HEADER = (
    "# Signataires de confiance de la mémoire\n\n"
    "Une note reçue d'un coéquipier ne va aux agents que si son dernier commit est\n"
    "signé par l'une de ces clés (SSH ou GPG, celles de la signature des commits git).\n"
    "Sans liste, toutes les notes sont crues comme avant.\n\n"
)


@dataclass(frozen=True)
class Signer:
    name: str
    kind: str
    """``ssh`` or ``gpg``."""
    key: str
    """``<type> <base64>`` for SSH, the upper-case fingerprint for GPG."""
    fingerprint: str
    """What git reports for a signature (``%GF``): ``SHA256:…`` for SSH, the
    hexadecimal fingerprint for GPG."""

    def line(self) -> str:
        return f"{self.name} {self.key}"

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "kind": self.kind, "fingerprint": self.fingerprint}


def list_rel(base: Path | str) -> str:
    """The list's vault path, for the memory at *base*."""
    return (Path(base) / LIFECYCLE_DIR / FILE).as_posix()


def _ssh_fingerprint(kind: str, blob_b64: str) -> str | None:
    """``SHA256:<base64>`` of the key, as ``ssh-keygen -l`` and git print it,
    or ``None`` when the text is not a key of that type."""
    try:
        blob = base64.b64decode(blob_b64, validate=True)
        (size,) = struct.unpack(">I", blob[:4])
    except (binascii.Error, ValueError, struct.error):
        return None
    if blob[4 : 4 + size].decode("ascii", "replace") != kind:
        return None
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii")
    return "SHA256:" + digest.rstrip("=")


def parse_line(text: str) -> Signer | None:
    """One ``<name> <key>`` line, or ``None`` when it is not one."""
    line = str(text or "").strip()
    if not line or len(line) > _MAX_LINE or _CONTROL.search(line):
        return None
    name, _, rest = line.partition(" ")
    if not _NAME.fullmatch(name):
        return None
    tokens = rest.split()
    if len(tokens) >= 2 and tokens[0] in SSH_TYPES:
        found = _ssh_fingerprint(tokens[0], tokens[1])
        if found is None:
            return None
        return Signer(name, "ssh", f"{tokens[0]} {tokens[1]}", found)
    digits = "".join(tokens)
    if tokens and _HEX.fullmatch(digits):
        upper = digits.upper()
        return Signer(name, "gpg", upper, upper)
    return None


def clean(lines: list[str]) -> list[Signer] | None:
    """The signers as stored (one per key), or ``None`` when a line is not one."""
    out: list[Signer] = []
    for raw in lines:
        if not str(raw or "").strip():
            continue
        signer = parse_line(raw)
        if signer is None:
            return None
        if signer.fingerprint not in {s.fingerprint for s in out}:
            out.append(signer)
    return out if len(out) <= MAX_SIGNERS else None


def parse(text: str) -> list[Signer]:
    """The signers of a list file: a line a hand edit broke is skipped."""
    out: list[Signer] = []
    for line in (text or "").splitlines():
        if not line.startswith("- "):
            continue
        signer = parse_line(line[2:])
        if signer and signer.fingerprint not in {s.fingerprint for s in out}:
            out.append(signer)
    return out[:MAX_SIGNERS]


_VAULT_HEADER = (
    "# Signataires de confiance du cerveau\n\n"
    "Une note hors des projets (connaissances, instructions partagées, skills) reçue\n"
    "d'un coéquipier ne va aux agents que si son dernier commit est signé par l'une\n"
    "de ces clés. Chaque projet a sa propre liste pour ses notes.\n"
    "Sans liste, toutes les notes sont crues comme avant.\n\n"
)


def render(signers: list[Signer], *, header: str = _HEADER) -> str:
    return header + "".join(f"- {s.line()}\n" for s in signers)


def _replace(root: Path, rel: str, kept: list[Signer], header: str) -> None:
    target = inside(root, rel)
    if kept:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render(kept, header=header), encoding="utf-8", newline="\n")
    else:
        target.unlink(missing_ok=True)


def write_vault(root: Path, lines: list[str]) -> list[Signer] | None:
    """Replace the vault's list; ``None`` when a line is refused (nothing is
    written). An empty list removes the file: every note outside the projects
    is trusted again."""
    kept = clean(lines)
    if kept is None:
        return None
    _replace(root, VAULT_LIST, kept, _VAULT_HEADER)
    return kept


def write(
    root: Path, base: Path | str, lines: list[str], *, actor: str = "user"
) -> list[Signer] | None:
    """Replace the list; ``None`` when a line is refused (nothing is written).

    An empty list removes the file: the memory trusts every note again.
    """
    kept = clean(lines)
    if kept is None:
        return None
    _replace(root, list_rel(base), kept, _HEADER)
    append(
        root,
        base,
        JournalEntry(
            action="designate",
            actor=actor,
            note=list_rel(base),
            title="trusted signers",
            reason_code="signers-changed",
            reason=", ".join(s.name for s in kept),
        ),
    )
    return kept
