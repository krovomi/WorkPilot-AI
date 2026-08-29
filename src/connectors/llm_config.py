"""
Gestion sécurisée de la configuration des providers LLM (clés API, endpoints, etc.).
Permet l'enregistrement, la récupération et la validation des paramètres providers.
"""

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from apps.backend.core.auth import get_auth_token

logger = logging.getLogger(__name__)


def _mask_secret(value: str) -> str:
    """Renvoie un placeholder pour une clé API dans les logs.

    On n'écho aucun caractère du secret : même un préfixe de 8 caractères réduit
    significativement l'entropie pour un attaquant qui aurait accès aux logs.
    """
    if not value:
        return "***"
    return f"<redacted, {len(value)} chars>"


CONFIG_FILE = Path.home() / ".work_pilot_ai_llm_providers.json"


class ProviderConfig:
    """Configuration class for LLM providers."""

    def __init__(
        self,
        provider: str,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        **kwargs,
    ):
        self.provider = provider
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.is_claude_sdk = provider in ["anthropic-sdk", "claude"]
        for key, value in kwargs.items():
            setattr(self, key, value)

    @classmethod
    def load_provider_config(
        cls,
        phase: str,
        spec_dir: str,
        cli_provider: str | None = None,
        cli_model: str | None = None,
    ):
        """Load provider configuration from various sources.

        Priority:
        1. CLI provider + config file entry (if provider has saved config)
        2. CLI provider + auth token (for anthropic/claude providers)
        3. CLI provider + cli_model (for other providers like openai, ollama)
        4. Default: anthropic provider with system auth token
        """
        provider = cli_provider or "anthropic"
        model = cli_model or "claude-3-sonnet-20240229"

        # Try to load saved provider config from ~/.work_pilot_ai_llm_providers.json
        config_data = load_provider_config(provider)
        if config_data:
            return cls(
                provider=provider,
                model=cli_model or config_data.get("model", model),
                api_key=config_data.get("api_key"),
                base_url=config_data.get("base_url"),
                **{
                    k: v
                    for k, v in config_data.items()
                    if k not in ["provider", "model", "api_key", "base_url"]
                },
            )

        # No saved config — try system auth token for Anthropic/Claude providers
        if provider in ("anthropic", "claude"):
            token = get_auth_token()
            if token and token.startswith("sk-"):
                return cls(provider=provider, model=model, api_key=token)

        # For other providers (openai, ollama, google, etc.), return config
        # with the model from task_metadata.json — API keys should be in env vars
        # or in the saved provider config file
        return cls(provider=provider, model=model)


# CONFIG_FILE holds API keys in clear text and every mutation is a
# read-modify-write of the WHOLE file. Two things follow:
#   * the write must be atomic — a crash or a full disk mid-`json.dump` used to
#     truncate the file and take every provider's key with it;
#   * concurrent writers must be serialised — these functions are reached from
#     FastAPI endpoints, and uvicorn runs sync endpoints on a thread pool, so
#     two requests could interleave their read-modify-write and silently drop
#     one of the two updates.
_CONFIG_LOCK = threading.Lock()


def _write_all_provider_configs(all_configs: dict[str, Any]) -> None:
    """Atomically replace CONFIG_FILE, owner-readable only.

    The temp file is created in the same directory so `os.replace` stays on one
    filesystem (and is therefore atomic). Permissions are tightened *before* the
    rename so the secrets are never briefly world-readable. On Windows `chmod`
    only toggles the read-only bit, but the file lives under the user profile,
    whose ACL already restricts it to the owner.
    """
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(CONFIG_FILE.parent), prefix=".llm_providers-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(all_configs, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, CONFIG_FILE)
    except BaseException:
        # Never leave a stray temp file holding a copy of the API keys.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def save_provider_config(name: str, config: dict[str, Any]) -> None:
    """Enregistre la configuration d'un provider (clé API, endpoint, etc.)."""
    with _CONFIG_LOCK:
        all_configs = load_all_provider_configs()
        all_configs[name] = config
        _write_all_provider_configs(all_configs)


def load_provider_config(name: str) -> dict[str, Any] | None:
    """Charge la configuration d'un provider donné."""
    all_configs = load_all_provider_configs()
    return all_configs.get(name)


def _ensure_owner_only(path: Path) -> None:
    """Tighten an existing config file to 0600 if it is more permissive.

    Installs created before atomic writes landed have a world-readable 0644
    file full of API keys sitting in the home directory. They would only be
    repaired on the next write, which may never happen — so repair on read too.
    No-op on Windows, where the mode bits do not carry group/other permissions.
    """
    if os.name == "nt":
        return
    try:
        current = os.stat(path).st_mode & 0o777
        if current & 0o077:
            os.chmod(path, 0o600)
            logger.info("Tightened permissions on %s to 0600", path)
    except OSError:
        logger.debug("Could not adjust permissions on %s", path, exc_info=True)


def load_all_provider_configs() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        return {}
    _ensure_owner_only(CONFIG_FILE)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        # A corrupt file used to raise out of every endpoint that touches
        # provider config, leaving the app permanently stuck. Move it aside so
        # the user can still recover their keys by hand, and start clean.
        backup = CONFIG_FILE.with_suffix(CONFIG_FILE.suffix + ".corrupt")
        try:
            os.replace(CONFIG_FILE, backup)
            logger.error(
                "Provider config file was unreadable; moved to %s and starting "
                "from an empty configuration.",
                backup,
            )
        except OSError:
            logger.exception(
                "Provider config file is unreadable and could not be moved aside"
            )
        return {}
    if not isinstance(data, dict):
        logger.error(
            "Provider config file does not contain a JSON object; ignoring it."
        )
        return {}
    return data


def delete_provider_config(name: str) -> None:
    with _CONFIG_LOCK:
        all_configs = load_all_provider_configs()
        if name in all_configs:
            del all_configs[name]
            _write_all_provider_configs(all_configs)


def list_provider_configs() -> list[str]:
    return [k for k in load_all_provider_configs() if not k.startswith("__")]


_ACTIVE_PROVIDER_KEY = "__active_provider__"


def set_active_provider(name: str) -> None:
    """Persist the currently selected provider in the config file."""
    with _CONFIG_LOCK:
        all_configs = load_all_provider_configs()
        all_configs[_ACTIVE_PROVIDER_KEY] = name
        _write_all_provider_configs(all_configs)


def get_active_provider() -> str | None:
    """Return the name of the provider previously selected, or None."""
    return load_all_provider_configs().get(_ACTIVE_PROVIDER_KEY)


def get_claude_token_from_system() -> str | None:
    """Récupère le token Claude Code depuis le keychain/credential manager (via core.auth)."""
    token = get_auth_token()
    if token and token.startswith("sk-"):
        return token
    return None


def force_claude_provider_config():
    """Crée ou met à jour la config provider 'claude' à partir du token système."""
    token = get_auth_token()
    if token and token.startswith("sk-"):
        config = {"api_key": token, "model": "claude-3-sonnet-20240229"}
        save_provider_config("claude", config)
        logger.info("force_claude_provider_config - config sauvegardée.")
    else:
        logger.warning(
            "force_claude_provider_config - aucun token Claude valide trouvé."
        )
