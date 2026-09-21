"""Shared local-provider endpoints and fail-closed offline policy enforcement."""

from __future__ import annotations

import ipaddress
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

LOCAL_PROVIDERS = ("ollama", "lm-studio", "llama-cpp")
_ALIASES = {"lmstudio": "lm-studio", "local": "ollama"}


def local_endpoint(provider: str) -> str:
    """Resolve each runtime independently; offline endpoints must be loopback."""
    provider = _ALIASES.get(provider, provider)
    settings = {
        "ollama": ("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        "lm-studio": ("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234"),
        "llama-cpp": ("LLAMA_CPP_BASE_URL", "http://127.0.0.1:8080"),
    }
    if provider not in settings:
        raise ValueError(f"Offline mode requires a local provider: {provider}")
    variable, default = settings[provider]
    endpoint = os.environ.get(variable) or default
    parsed = urlsplit(endpoint)
    host = parsed.hostname or ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if (
        parsed.scheme not in {"http", "https"}
        or not loopback
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"Offline mode requires a loopback endpoint for {provider}")
    root = endpoint.rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1", "/api"):
        if root.endswith(suffix):
            root = root[: -len(suffix)]
            break
    return root


def is_local_provider(provider: str | None) -> bool:
    """Does this provider run on the machine, whichever way it is spelled?

    `lmstudio` / `lm-studio` and `local` / `ollama` are the same runtime under
    two names, and `_ALIASES` is what reconciles them. Exporting that table so
    each caller could re-do the lookup is how a private mapping becomes a
    second, divergent answer; the question callers actually have is this one.
    """
    value = (provider or "").strip().lower()
    return _ALIASES.get(value, value) in LOCAL_PROVIDERS


def _policy_files(*paths: Path | str | None) -> list[Path]:
    """Every policy file governing these paths, worktree and spec ancestors alike.

    Split out of `project_policies` so that "which file says so" and "what
    does it say" are one search answered twice, rather than two searches that
    drift. A message naming the rule without naming the file that carries it
    sends its reader hunting through a settings screen they may not know
    exists.
    """
    files: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        if path is None:
            continue
        start = Path(path).resolve()
        for directory in (start, *start.parents):
            candidate = directory / ".workpilot" / "offline-mode.json"
            if candidate in seen:
                continue
            seen.add(candidate)
            if candidate.exists():
                files.append(candidate)
    return files


def _read_policy(path: Path) -> dict:
    policy = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(policy, dict) or not isinstance(
        policy.get("airgapStrict", False), bool
    ):
        raise ValueError("Invalid offline policy")
    return policy


def project_policies(*paths: Path | str | None) -> list[dict]:
    """Check both worktree and original spec ancestors, without hiding corrupt policy."""
    return [_read_policy(path) for path in _policy_files(*paths)]


# La seule sortie d'un mode strict, écrite une fois. Un message qui décrit la
# barriere sans dire ou est l'interrupteur laisse son lecteur chercher dans les
# reglages d'un produit qui en a quatre-vingts.
STRICT_EXIT_HINT = (
    "Uncheck 'Airgap strict' in Settings -> Offline Mode to let this project "
    "reach a cloud provider again, or route the task to a locally installed model."
)


def airgap_status(*paths: Path | str | None) -> dict:
    """Is this project under a strict offline policy, and which file says so?

    `project_policies` has always known, but only callers willing to walk its
    output could tell — and nothing outside this module did. So the one fact
    that overrides every provider choice in the product was readable in
    exactly one screen of the application: a checkbox on the Offline Mode
    page. Everywhere else, selecting Anthropic showed a green "OK" and then
    failed on a local model nobody had named.

    Returns the flag and the policy file, so a status endpoint, a contest
    fielding cloud providers and an error message can all say the same thing
    without each re-reading the JSON.
    """
    for path in _policy_files(*paths):
        policy = _read_policy(path)
        if policy.get("airgapStrict"):
            return {"airgapStrict": True, "policyPath": str(path)}
    return {"airgapStrict": False, "policyPath": None}


def guard_cloud_client(*paths: Path | str | None) -> None:
    if any(policy.get("airgapStrict") for policy in project_policies(*paths)):
        raise ValueError(
            "Offline mode blocks this cloud-only operation. "
            "Use an operation supporting a local agent client."
        )


def resolve_offline_route(
    project_dir: Path,
    spec_dir: Path,
    task: str,
    provider: str,
    model: str,
    *,
    chosen: bool = False,
) -> tuple[str, str, str | None]:
    """Where this task runs, once the project's offline policy has had its say.

    Two policies wear the same file, and conflating them is what made a run
    configured for Anthropic die on ``Local model llama3.3:latest is
    unavailable on ollama``:

    * **Strict (``airgapStrict: true``) is a barrier.** Its routing table
      replaces whatever the caller wanted, and a route that cannot be honoured
      is a hard error — there is no legal fallback, since the whole point is
      that no cloud call leaves the machine.
    * **Hybrid (``airgapStrict: false``) is a default.** The page itself says
      so: *"le mode strict est désactivé : les opérations sans route locale
      peuvent encore utiliser le cloud"*. A default answers for a caller that
      named nothing; it does not overrule a caller that named something.

    ``chosen`` is that distinction. It is True when the pair passed in is a
    decision somebody took for this run — a contestant of the Bounty Board
    naming its own provider, the "Fournisseur IA" list, a per-task metadata
    entry — and False when it is the fallback
    :data:`core.client._DEFAULT_PROVIDER` nobody asked for. Without it every
    caller looked explicit (``create_agent_client`` resolves the provider
    *before* calling here), so a hybrid table silently redirected six phases of
    every build to a local model, and the only symptom was an error naming a
    provider the user had never selected.

    A local pair the caller chose is still validated, and a broken one still
    raises: running ``anthropic`` because ``ollama`` is not ready is a
    substitution nobody asked for. Only a **hybrid route** — a default this
    function applied on its own — declines instead, and says why.
    """
    policies = project_policies(project_dir, spec_dir)
    strict = any(policy.get("airgapStrict") for policy in policies)
    selected = next((p for p in policies if p.get("airgapStrict")), None)
    if selected is None:
        selected = policies[0] if policies else {}
    route = selected.get("routing", {}).get(task)
    if not route and strict:
        default_provider = selected.get("defaultProvider")
        route = next(
            (
                entry
                for entry in selected.get("routing", {}).values()
                if entry.get("provider") == default_provider and entry.get("model")
            ),
            None,
        )
    if not strict and not route:
        return provider, model, None

    from phase_config import is_hosted_only_model

    # A phase's own local provider/model pair is more specific than the project
    # default, including the fallback borrowed from another phase in strict mode.
    # Keep invalid local choices too: validation below must reject them rather
    # than silently running a different model.
    selected_local_model = (
        is_local_provider(provider) and bool(model) and not is_hosted_only_model(model)
    )
    requested_provider, requested_model = provider, model
    honour_route = bool(route) and not selected_local_model and (strict or not chosen)
    if honour_route:
        provider, model = route["provider"], route["model"]

    provider = _ALIASES.get(provider, provider)
    if provider not in LOCAL_PROVIDERS:
        if strict:
            raise ValueError(
                f"Strict offline mode blocks cloud provider {provider} for {task}. "
                + STRICT_EXIT_HINT
            )
        return provider, model, None

    def _decline(reason: str) -> tuple[str, str, str | None]:
        """Refuse a pair the caller chose; step aside for a route it did not.

        Failing a build over a *default* is the one outcome nobody asked for:
        hybrid mode permits the cloud by definition, so a route pointing at a
        model that is no longer installed costs a log line, not the run.
        """
        if strict or not honour_route:
            raise ValueError(reason)
        logger.warning(
            "[offline] %s — hybrid routing declines; %s runs on %s:%s as selected.",
            reason,
            task,
            requested_provider,
            requested_model,
        )
        return requested_provider, requested_model, None

    # Ce que le message doit expliquer n'est pas seulement quel modele manque,
    # mais pourquoi ce fournisseur-la est celui qu'on essaie : en mode strict,
    # le choix de l'utilisateur a ete remplace, et ne pas le dire produit
    # exactement le rapport de bug qui a amene ici — « j'ai choisi Anthropic et
    # ca me parle d'ollama ».
    if honour_route and strict:
        origin = (
            f" — strict offline mode routes {task} there, replacing "
            f"{requested_provider}, the provider selected for this run"
        )
    elif honour_route:
        origin = f" — the offline-mode policy routes {task} there"
    else:
        origin = f" — selected for {task}"
    exit_hint = f" {STRICT_EXIT_HINT}" if strict else ""
    from ollama_model_detector import is_embedding_model

    if not model or is_embedding_model(model):
        return _decline(f"Select a local generation model for {task}")
    try:
        endpoint = local_endpoint(provider)
    except ValueError as exc:
        return _decline(str(exc))
    from core.local_model_catalog import detect_runtime

    runtime = detect_runtime(provider)
    if not runtime.get("available"):
        return _decline(
            f"Local runtime {provider} is not running, and {task} is routed to "
            f"it{origin}.{exit_hint}"
        )
    if model not in {entry["name"] for entry in runtime.get("models", [])}:
        return _decline(
            f"Local model {model} is not installed on {provider}{origin}. "
            f"Install it, or pick an installed model in Settings -> Offline "
            f"Mode.{exit_hint}"
        )
    return provider, model, endpoint
