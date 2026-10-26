"""What each LLM provider can do, read from capabilities/providers.yaml.

Used at client-creation time to answer two questions honestly:

* Does this provider run subagents? If not, passing an ``agents`` dict is
  dead weight — the workflow should run its phases sequentially with a context
  reset instead of pretending to dispatch them in parallel.
* Does this provider have an agentic adapter at all? Five of them do not, and
  selecting one silently ran the task on Claude. The degradation still happens
  (writing five adapters is a separate piece of work) but it is now stated in
  the task feed rather than buried in a log line.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

__all__ = [
    "AcpSpec",
    "ProviderCapabilities",
    "acp_provider_names",
    "get_provider_capabilities",
    "load_providers",
]

PROVIDERS_RELPATH = Path("capabilities") / "providers.yaml"

# capabilities/ sits at the repo root, two levels above apps/backend/.
_REPO_ROOT = Path(__file__).resolve().parents[3]


#: What may appear in an ACP agent's launch vector, a mode id or a method id:
#: the vector is run without a shell, but a `.cmd` launcher on Windows is
#: parsed by cmd.exe, so the alphabet of `cli_subprocess._SAFE_OPTION_VALUE`.
_ACP_TOKEN = re.compile(r"^[A-Za-z0-9._:@#+=-]+$")
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


@dataclass(frozen=True)
class AcpSpec:
    """How to start one Agent Client Protocol agent, from its `acp:` block.

    Nothing here says what the agent *can* do: that is what it declares in
    ``initialize``, read at run time (`core/agent_clients/acp.py`). This is only
    how to reach it and which of its modes keep a person in the loop.
    """

    command: tuple[str, ...]
    model_flag: str | None = None
    model_prefixes: tuple[str, ...] = ()
    approval_mode: str | None = None
    read_only_mode: str | None = None
    auto_approve_modes: tuple[str, ...] = ()
    auth_env: tuple[tuple[str, str], ...] = ()
    label: str = ""
    login: str = ""
    docs: str = ""

    @property
    def executable(self) -> str:
        return self.command[0]


def _acp_tokens(value: object, field: str, name: str) -> tuple[str, ...]:
    items = value if isinstance(value, list) else ([] if value is None else [value])
    out: list[str] = []
    for item in items:
        if not isinstance(item, str) or not _ACP_TOKEN.fullmatch(item):
            raise ValueError(
                f"providers.yaml {name}.acp.{field}: invalid value {item!r}"
            )
        out.append(item)
    return tuple(out)


def _parse_acp(name: str, raw: object) -> AcpSpec | None:
    """The `acp:` block, refused whole when any part of it is malformed.

    A launch vector is code that runs on the person's machine: an entry that
    does not parse is an error at load time, never a guess at run time.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError(f"providers.yaml {name}.acp must be a mapping")
    command = _acp_tokens(raw.get("command"), "command", name)
    if not command or "/" in command[0] or "\\" in command[0]:
        raise ValueError(
            f"providers.yaml {name}.acp.command must start with a bare executable name"
        )
    auth = raw.get("auth_env") or {}
    if not isinstance(auth, dict):
        raise ValueError(f"providers.yaml {name}.acp.auth_env must be a mapping")
    pairs: list[tuple[str, str]] = []
    for method, variable in auth.items():
        _acp_tokens(method, "auth_env", name)
        if not isinstance(variable, str) or not _ENV_NAME.fullmatch(variable):
            raise ValueError(
                f"providers.yaml {name}.acp.auth_env: invalid variable {variable!r}"
            )
        pairs.append((str(method), variable))

    def one(field: str) -> str | None:
        tokens = _acp_tokens(raw.get(field), field, name)
        return tokens[0] if tokens else None

    return AcpSpec(
        command=command,
        model_flag=one("model_flag"),
        model_prefixes=tuple(str(p) for p in raw.get("model_prefixes") or ()),
        approval_mode=one("approval_mode"),
        read_only_mode=one("read_only_mode"),
        auto_approve_modes=_acp_tokens(
            raw.get("auto_approve_modes"), "auto_approve_modes", name
        ),
        auth_env=tuple(pairs),
        label=str(raw.get("label") or name),
        login=str(raw.get("login") or ""),
        docs=str(raw.get("docs") or ""),
    )


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    adapter: str | None
    subagents: str
    effort: str
    degrades_to: str | None
    note: str = ""
    # How the context window is managed (see the `context` field documented at
    # the top of providers.yaml). Unknown providers get the conservative
    # answer: WorkPilot emulates compaction and can only estimate the fill.
    context_compact: str = "emulated"
    context_usage: str = "estimated"
    # Set for an Agent Client Protocol agent (`adapter: AcpAgentClient`).
    acp: AcpSpec | None = None

    @property
    def supports_subagents(self) -> bool:
        """Whether a roster reaches the model on this provider, by any route.

        ``native`` (the Claude SDK) and ``emulated`` (the ``delegate`` tool
        and a child session per delegation) both do; ``none`` is the CLIs and
        the providers without an adapter.
        """
        return self.subagents in ("native", "emulated")

    @property
    def emulates_subagents(self) -> bool:
        return self.subagents == "emulated"

    @property
    def has_adapter(self) -> bool:
        return bool(self.adapter)


_UNKNOWN = ProviderCapabilities(
    name="unknown",
    adapter=None,
    subagents="none",
    effort="none",
    degrades_to="claude",
    note="Not listed in capabilities/providers.yaml.",
)


def load_providers(repo_root: Path | None = None) -> dict[str, ProviderCapabilities]:
    path = (repo_root or _REPO_ROOT) / PROVIDERS_RELPATH
    if not path.is_file():
        logger.warning("provider capability matrix not found at %s", path)
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, ProviderCapabilities] = {}
    for name, cfg in raw.items():
        cfg = cfg or {}
        context = cfg.get("context") or {}
        out[name] = ProviderCapabilities(
            name=name,
            adapter=cfg.get("adapter"),
            subagents=str(cfg.get("subagents", "none")),
            effort=str(cfg.get("effort", "none")),
            degrades_to=cfg.get("degrades_to"),
            note=str(cfg.get("note", "") or ""),
            context_compact=str(context.get("compact", "emulated")),
            context_usage=str(context.get("usage", "estimated")),
            acp=_parse_acp(name, cfg.get("acp")),
        )
    return out


@lru_cache(maxsize=1)
def _cached() -> dict[str, ProviderCapabilities]:
    return load_providers()


# Les orthographes qui désignent le même fournisseur que la matrice. Elles
# existent parce que l'UI dit « anthropic » là où `providers.yaml` dit
# « claude », et que les runtimes locaux sont écrits avec ou sans tiret selon
# l'appelant. Sans elles, la réponse prudente ci-dessous — « pas d'adaptateur »
# — est rendue pour un fournisseur qui en a un, ce qui est le seul sens où se
# tromper coûte cher : un appelant qui refuse ce qu'il sait faire tourner.
_PROVIDER_ALIASES = {
    "anthropic": "claude",
    "lm-studio": "lmstudio",
    "llama-cpp": "local",
    "agy": "antigravity",
}


def get_provider_capabilities(provider: str) -> ProviderCapabilities:
    """Capabilities for ``provider``.

    An unlisted provider gets the conservative answer — no subagents, no
    adapter — rather than an optimistic default. Assuming capability a provider
    does not have fails at run time in a confusing way; assuming the opposite
    only costs some parallelism.
    """
    provider = _PROVIDER_ALIASES.get(provider, provider)
    caps = _cached().get(provider)
    if caps is None:
        logger.debug("provider %r not in the capability matrix", provider)
        return ProviderCapabilities(
            name=provider,
            adapter=_UNKNOWN.adapter,
            subagents=_UNKNOWN.subagents,
            effort=_UNKNOWN.effort,
            degrades_to=_UNKNOWN.degrades_to,
            note=_UNKNOWN.note,
        )
    return caps


def acp_provider_names() -> tuple[str, ...]:
    """The providers driven over the Agent Client Protocol, one per entry."""
    return tuple(name for name, caps in _cached().items() if caps.acp is not None)
