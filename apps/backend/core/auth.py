"""
Authentication helpers for WorkPilot AI.

Provides centralized authentication token resolution with fallback support
for multiple environment variables, and SDK environment variable passthrough
for custom API endpoints.
"""

import hashlib
import json
import logging
import os
import subprocess
from typing import TYPE_CHECKING

# Re-export the canonical platform predicates so existing local callers
# in this module keep working unchanged. Previously these were duplicated
# wrappers (is_linux/is_macos/is_windows redefined here) — the
# duplication drifted from `foundation.platform` and forced us to keep two
# implementations in sync.
from foundation.platform import is_linux, is_macos, is_windows  # noqa: F401

logger = logging.getLogger(__name__)


def _token_presence(token: str | None) -> str:
    """Return a non-sensitive presence indicator for a token, suitable for logs.

    We deliberately avoid hashing or truncating the token: even a 12-char SHA-256
    prefix is enough to pin down a known secret in a short list, and CodeQL flags
    SHA-256 as too fast for credential-derived hashes. Logging only presence + length
    gives us enough signal to debug "is the token loaded? did it change?" without
    putting any token-derived bytes in logs.
    """
    if not token:
        return "absent"
    return f"present(len={len(token)})"


# Optional import for Linux secret-service support
# secretstorage provides access to the Freedesktop.org Secret Service API via DBus
if TYPE_CHECKING:
    import secretstorage
else:
    try:
        import secretstorage  # type: ignore[import-untyped]
    except ImportError:
        secretstorage = None  # type: ignore[assignment]
        # Warn only on Linux: on Windows/macOS `secretstorage` is not used at all,
        # so its absence is expected and should not spam the logs.
        if is_linux():
            logger.warning(
                "secretstorage is not installed — tokens on Linux will not be "
                "read from the Freedesktop Secret Service. "
                "Install with: pip install secretstorage"
            )

# Priority order for auth token resolution
# NOTE: We intentionally do NOT fall back to ANTHROPIC_API_KEY.
# WorkPilot AI is designed to use Claude Code OAuth tokens only.
# This prevents silent billing to user's API credits when OAuth fails.
AUTH_TOKEN_ENV_VARS = [
    "CLAUDE_CODE_OAUTH_TOKEN",  # OAuth token from Claude Code CLI
    "ANTHROPIC_AUTH_TOKEN",  # CCR/proxy token (for enterprise setups)
]

# Environment variables to pass through to SDK subprocess
# NOTE: ANTHROPIC_API_KEY is intentionally excluded to prevent silent API billing
SDK_ENV_VARS = [
    # API endpoint configuration
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    # Model overrides (from API Profile custom model mappings)
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    # SDK behavior configuration
    "NO_PROXY",
    "DISABLE_TELEMETRY",
    "DISABLE_COST_WARNINGS",
    "API_TIMEOUT_MS",
    # Windows-specific: Git Bash path for Claude Code CLI
    "CLAUDE_CODE_GIT_BASH_PATH",
    # Claude CLI path override (allows frontend to pass detected CLI path to SDK)
    "CLAUDE_CLI_PATH",
    # Profile's custom config directory (for multi-profile token storage)
    "CLAUDE_CONFIG_DIR",
]


def _calculate_config_dir_hash(config_dir: str) -> str:
    """
    Calculate hash of config directory path for Keychain service name.

    This MUST match the frontend's calculateConfigDirHash() in credential-utils.ts.
    The frontend uses SHA256 hash of the config dir path, taking first 8 hex chars.

    Args:
        config_dir: Path to the config directory (should be absolute/expanded)

    Returns:
        8-character hex hash string (e.g., "d74c9506")
    """
    return hashlib.sha256(config_dir.encode()).hexdigest()[:8]


def _get_keychain_service_name(config_dir: str | None = None) -> str:
    """
    Get the Keychain service name for credential storage.

    This MUST match the frontend's getKeychainServiceName() in credential-utils.ts.
    All profiles use hash-based keychain entries for isolation:
    - Profile with configDir: "Claude Code-credentials-{hash}"
    - No configDir (legacy/default): "Claude Code-credentials"

    Args:
        config_dir: Optional CLAUDE_CONFIG_DIR path. If provided, uses hash-based name.

    Returns:
        Keychain service name (e.g., "Claude Code-credentials-d74c9506")
    """
    if not config_dir:
        return "Claude Code-credentials"

    # Expand ~ to home directory (matching frontend normalization)
    expanded_dir = os.path.expanduser(config_dir)

    # Calculate hash and return hash-based service name
    hash_suffix = _calculate_config_dir_hash(expanded_dir)
    return f"Claude Code-credentials-{hash_suffix}"


def is_encrypted_token(token: str | None) -> bool:
    """Whether a token is in Claude Code's encrypted form (``enc:`` prefix)."""
    return bool(token and token.startswith("enc:"))


def validate_token_not_encrypted(token: str) -> None:
    """Refuse a token WorkPilot cannot use as is.

    Claude Code can store its token encrypted (``enc:…``). WorkPilot does not
    decrypt it, and the SDK would fail later with a less helpful message, so
    the token is refused here, before it reaches the SDK.

    Raises:
        ValueError: If the token is in encrypted format (``enc:…``).
    """
    if is_encrypted_token(token):
        raise ValueError(
            "Authentication token is in encrypted format and cannot be used.\n\n"
            "WorkPilot AI does not decrypt Claude Code tokens.\n\n"
            "To fix this issue:\n"
            "  1. Re-authenticate with Claude Code CLI: claude setup-token\n"
            "  2. Or set CLAUDE_CODE_OAUTH_TOKEN to a plaintext token in your .env file"
        )


def _oauth_token(credentials: object) -> str | None:
    """The OAuth token in a Claude Code credentials document, if it holds one.

    The document is JSON written by Claude Code (keychain entry or
    ``.credentials.json``): ``{"claudeAiOauth": {"accessToken": "…"}}``, or the
    older ``oauthAccount`` key. Only a Claude OAuth token (``sk-ant-oat01-``) or
    its encrypted form (``enc:``) is accepted; anything else reads as no token.
    """
    if not isinstance(credentials, dict):
        return None
    oauth = credentials.get("claudeAiOauth") or credentials.get("oauthAccount")
    token = oauth.get("accessToken") if isinstance(oauth, dict) else None
    if isinstance(token, str) and token.startswith(("sk-ant-oat01-", "enc:")):
        return token
    return None


def _token_from_json(text: str) -> str | None:
    try:
        return _oauth_token(json.loads(text))
    except json.JSONDecodeError:
        return None


def _token_from_file(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError) as e:
        logger.debug("Failed to read %s: %s", path, e)
        return None
    token = _token_from_json(text)
    if token:
        logger.debug("Found token in %s", path)
    return token


def get_token_from_keychain(config_dir: str | None = None) -> str | None:
    """
    Get authentication token from system credential store.

    Reads Claude Code credentials from:
    - macOS: Keychain (uses hash-based service name if config_dir provided)
    - Windows: the credential files Claude Code writes
    - Linux: Secret Service API (via dbus/secretstorage), then ~/.claude/.credentials.json

    Args:
        config_dir: Optional CLAUDE_CONFIG_DIR path for profile-specific credentials.
                   When provided, reads from hash-based keychain entry matching
                   the frontend's storage location, and never from the default
                   entry (that would be another profile's token).

    Returns:
        Token string if found, None otherwise
    """
    if is_macos():
        return _get_token_from_macos_keychain(config_dir)
    elif is_windows():
        return _get_token_from_windows_credential_files(config_dir)
    else:
        # Linux: use secret-service API via DBus
        return _get_token_from_linux_credentials(config_dir)


def _get_token_from_macos_keychain(config_dir: str | None = None) -> str | None:
    """Get token from macOS Keychain.

    Args:
        config_dir: Optional CLAUDE_CONFIG_DIR path. When provided, uses hash-based
                   service name (e.g., "Claude Code-credentials-d74c9506") matching
                   the frontend's credential storage location.
    """
    service_name = _get_keychain_service_name(config_dir)
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service_name, "-w"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None

    if result.returncode != 0:
        logger.debug("No keychain entry found for service '%s'", service_name)
        return None

    token = _token_from_json(result.stdout.strip())
    if token:
        logger.debug("Found token in keychain service '%s'", service_name)
    return token


def _get_token_from_windows_credential_files(
    config_dir: str | None = None,
) -> str | None:
    """Get token from Windows credential files.

    Claude Code on Windows stores credentials in ~/.claude/.credentials.json.
    For a profile, only that profile's config_dir is read.

    Args:
        config_dir: Optional CLAUDE_CONFIG_DIR path for profile-specific credentials.
    """
    if config_dir:
        return _get_token_from_config_dir(config_dir)

    cred_paths = [
        os.path.expandvars(r"%USERPROFILE%\.claude\.credentials.json"),
        os.path.expandvars(r"%USERPROFILE%\.claude\credentials.json"),
        os.path.expandvars(r"%LOCALAPPDATA%\Claude\credentials.json"),
        os.path.expandvars(r"%APPDATA%\Claude\credentials.json"),
    ]
    for cred_path in cred_paths:
        if os.path.exists(cred_path):
            token = _token_from_file(cred_path)
            if token:
                return token
    return None


def _get_token_from_linux_credentials(config_dir: str | None = None) -> str | None:
    """Get token on Linux: the Secret Service, then Claude Code's credentials file.

    Claude Code on Linux writes ``~/.claude/.credentials.json``; the Secret
    Service holds it when a keyring is set up. A profile's own file is read by
    `_get_token_from_config_dir`, so only the default profile falls back to the
    file here.
    """
    token = _get_token_from_linux_secret_service(config_dir)
    if token or config_dir:
        return token
    return _get_token_from_config_dir(os.path.join("~", ".claude"))


def _get_token_from_linux_secret_service(config_dir: str | None = None) -> str | None:
    """Get token from Linux Secret Service API via DBus.

    The credential is stored with:
    - Label: "Claude Code-credentials" or "Claude Code-credentials-{hash}" for profiles
    - Attributes: {application: "claude-code"}

    Args:
        config_dir: Optional CLAUDE_CONFIG_DIR path for profile-specific credentials.

    Returns:
        Token string if found, None otherwise
    """
    if secretstorage is None:
        return None

    target_label = _get_keychain_service_name(config_dir)
    errors = secretstorage.exceptions.SecretStorageException
    try:
        connection = secretstorage.dbus_init()
    except errors:
        # No session bus, or no Secret Service on it
        return None

    try:
        collection = secretstorage.get_default_collection(connection)
        # Unlocking may prompt the user; a dismissed prompt means no token
        if collection.is_locked() and collection.unlock():
            return None
        for item in collection.search_items({"application": "claude-code"}):
            # Exact label: a profile never reads another profile's entry
            if item.get_label() != target_label:
                continue
            secret = item.get_secret().decode("utf-8", errors="replace")
            token = _token_from_json(secret)
            if token:
                logger.debug(
                    "Found token in secret service with label '%s'", target_label
                )
                return token
    except errors:
        # Item gone, keyring refused, DBus error: no token from here
        return None
    finally:
        connection.close()

    logger.debug("No secret service entry found with label '%s'", target_label)
    return None


def _get_token_from_config_dir(config_dir: str) -> str | None:
    """
    Read token from a custom config directory's credentials file.

    Claude Code stores credentials in .credentials.json within the config directory.
    This function reads from a profile's custom configDir instead of the default location.

    Args:
        config_dir: Path to the config directory (e.g., ~/.workpilot/profiles/work)

    Returns:
        Token string if found, None otherwise
    """
    expanded_dir = os.path.expanduser(config_dir)
    for name in (".credentials.json", "credentials.json"):
        cred_path = os.path.join(expanded_dir, name)
        if os.path.exists(cred_path):
            token = _token_from_file(cred_path)
            if token:
                return token
    return None


#: Providers whose sessions are authenticated by the Claude Code OAuth token
#: this module fetches. Everything else — Ollama and the other local servers,
#: OpenAI, Google, Mistral, Copilot, Windsurf… — carries its own credential,
#: supplied by the frontend's credential manager or by the local server needing
#: none at all.
CLAUDE_OAUTH_PROVIDERS = frozenset({"claude", "anthropic"})


def provider_requires_claude_oauth(provider: str | None) -> bool:
    """Whether a build on `provider` needs the Claude Code OAuth token.

    The CLI used to demand that token before every build, whatever the task was
    configured to run on. A user who had picked Ollama in the UI got the task
    accepted by the frontend — which asks this same question and answers it
    correctly — and then refused by the backend a second later, with a message
    telling them to authenticate against a service their build never touches.

    An unset provider means the default, and the default is Claude.
    """
    normalized = (provider or "").strip().lower()
    if not normalized:
        return True
    return normalized in CLAUDE_OAUTH_PROVIDERS


def get_auth_token(config_dir: str | None = None) -> str | None:
    """
    Get authentication token from environment variables or credential store.

    Args:
        config_dir: Optional custom config directory (profile's configDir).
                   If provided, reads credentials from this directory.
                   If None, checks CLAUDE_CONFIG_DIR env var, then uses default locations.

    Checks multiple sources in priority order:
    1. CLAUDE_CODE_OAUTH_TOKEN (env var)
    2. ANTHROPIC_AUTH_TOKEN (CCR/proxy env var for enterprise setups)
    3. Custom config directory (config_dir param or CLAUDE_CONFIG_DIR env var)
    4. System credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service)

    NOTE: ANTHROPIC_API_KEY is intentionally NOT supported to prevent
    silent billing to user's API credits when OAuth is misconfigured.

    A token in encrypted form ("enc:") is returned as is: WorkPilot does not
    decrypt it, and `configure_sdk_authentication` refuses it with a message
    saying how to get a plaintext one.

    Returns:
        Token string if found, None otherwise
    """
    # First check environment variables (highest priority)
    for var in AUTH_TOKEN_ENV_VARS:
        token = os.environ.get(var)
        if token:
            return token

    # Check CLAUDE_CONFIG_DIR environment variable (profile's custom config directory)
    env_config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    effective_config_dir = config_dir or env_config_dir

    # Debug: Log which config_dir is being used for credential resolution
    debug = os.environ.get("DEBUG", "").lower() in ("true", "1")
    if debug and effective_config_dir:
        service_name = _get_keychain_service_name(effective_config_dir)
        logger.info(
            f"[Auth] Resolving credentials for profile config_dir: {effective_config_dir} "
            f"(Keychain service: {service_name})"
        )

    # If a custom config directory is specified, read from there first
    if effective_config_dir:
        # Try reading from .credentials.json file in the config directory
        token = _get_token_from_config_dir(effective_config_dir)
        if token:
            return token

        # Also try the system credential store with hash-based service name
        # This is needed because macOS stores credentials in Keychain, not files
        token = get_token_from_keychain(effective_config_dir)
        if token:
            return token

        # If config_dir was explicitly provided, DON'T fall back to default keychain
        # - that would return the wrong profile's token
        logger.debug(
            f"No credentials found for config_dir '{effective_config_dir}' "
            "in file or keychain"
        )
        return None

    # No config_dir specified - use default system credential store
    return get_token_from_keychain()


def get_auth_token_source(config_dir: str | None = None) -> str | None:
    """
    Get the name of the source that provided the auth token.

    Args:
        config_dir: Optional custom config directory (profile's configDir).
                   If provided, checks this directory for credentials.
                   If None, checks CLAUDE_CONFIG_DIR env var.
    """
    # Same order as get_auth_token, so the name given is the token used
    for var in AUTH_TOKEN_ENV_VARS:
        if os.environ.get(var):
            return var

    effective_config_dir = config_dir or os.environ.get("CLAUDE_CONFIG_DIR")
    if effective_config_dir:
        if _get_token_from_config_dir(effective_config_dir):
            return "CLAUDE_CONFIG_DIR"
        if get_token_from_keychain(effective_config_dir):
            return f"{_credential_store_name(effective_config_dir)} (profile)"
        # A profile never falls back to the default credentials
        return None

    if get_token_from_keychain():
        return _credential_store_name(None)
    return None


def _credential_store_name(config_dir: str | None) -> str:
    """The name of the store `get_token_from_keychain` found the token in."""
    if is_macos():
        return "macOS Keychain"
    if is_windows():
        return "Windows Credential Files"
    if _get_token_from_linux_secret_service(config_dir):
        return "Linux Secret Service"
    return "~/.claude/.credentials.json"


def require_auth_token(config_dir: str | None = None) -> str:
    """
    Get authentication token or raise ValueError.

    Args:
        config_dir: Optional custom config directory (profile's configDir).
                   If provided, reads credentials from this directory.
                   If None, checks CLAUDE_CONFIG_DIR env var, then uses default locations.

    Raises:
        ValueError: If no auth token is found in any supported source
    """
    token = get_auth_token(config_dir)
    if not token:
        error_msg = (
            "No OAuth token found.\n\n"
            "WorkPilot AI requires Claude Code OAuth authentication.\n"
            "Direct API keys (ANTHROPIC_API_KEY) are not supported.\n\n"
        )
        # Provide platform-specific guidance
        if is_macos():
            error_msg += (
                "To authenticate:\n"
                "  1. Run: claude\n"
                "  2. Type: /login\n"
                "  3. Press Enter to open browser\n"
                "  4. Complete OAuth login in browser\n\n"
                "The token will be saved to macOS Keychain automatically."
            )
        elif is_windows():
            error_msg += (
                "To authenticate:\n"
                "  1. Run: claude\n"
                "  2. Type: /login\n"
                "  3. Press Enter to open browser\n"
                "  4. Complete OAuth login in browser\n\n"
                "The token will be saved to Windows Credential Manager."
            )
        else:
            # Linux
            error_msg += (
                "To authenticate:\n"
                "  1. Run: claude\n"
                "  2. Type: /login\n"
                "  3. Press Enter to open browser\n"
                "  4. Complete OAuth login in browser\n\n"
                "Or set CLAUDE_CODE_OAUTH_TOKEN in your .env file."
            )
        raise ValueError(error_msg)
    return token


def _find_git_bash_path() -> str | None:
    """
    Find git-bash (bash.exe) path on Windows.

    Uses 'where git' to find git.exe, then derives bash.exe location from it.
    Git for Windows installs bash.exe in the 'bin' directory alongside git.exe
    or in the parent 'bin' directory when git.exe is in 'cmd'.

    Returns:
        Full path to bash.exe if found, None otherwise
    """
    git_path = None

    # Method 1: Use 'where' command to find git.exe
    try:
        # Use where.exe explicitly for reliability
        result = subprocess.run(
            ["where.exe", "git"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            shell=False,
        )

        if result.returncode == 0 and result.stdout.strip():
            git_path = result.stdout.strip().splitlines()[0].strip()
    except (subprocess.SubprocessError, OSError):
        # Intentionally suppress errors - best-effort detection with fallback to common paths
        pass

    # Method 2: Check common installation paths if 'where' didn't work
    if not git_path:
        common_git_paths = [
            os.path.expandvars(r"%PROGRAMFILES%\Git\cmd\git.exe"),
            os.path.expandvars(r"%PROGRAMFILES%\Git\bin\git.exe"),
            os.path.expandvars(r"%PROGRAMFILES(X86)%\Git\cmd\git.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\cmd\git.exe"),
        ]
        for path in common_git_paths:
            if os.path.exists(path):
                git_path = path
                break

    if not git_path:
        return None

    # Derive bash.exe location from git.exe location
    # Git for Windows structure:
    #   C:\...\Git\cmd\git.exe     -> bash.exe is at C:\...\Git\bin\bash.exe
    #   C:\...\Git\bin\git.exe     -> bash.exe is at C:\...\Git\bin\bash.exe
    #   C:\...\Git\mingw64\bin\git.exe -> bash.exe is at C:\...\Git\bin\bash.exe
    git_dir = os.path.dirname(git_path)
    git_parent = os.path.dirname(git_dir)
    git_grandparent = os.path.dirname(git_parent)

    # Check common bash.exe locations relative to git installation
    possible_bash_paths = [
        os.path.join(git_parent, "bin", "bash.exe"),  # cmd -> bin
        os.path.join(git_dir, "bash.exe"),  # If git.exe is in bin
        os.path.join(git_grandparent, "bin", "bash.exe"),  # mingw64/bin -> bin
    ]

    for bash_path in possible_bash_paths:
        if os.path.exists(bash_path):
            return bash_path

    return None


def get_sdk_env_vars() -> dict[str, str]:
    """
    Get environment variables to pass to SDK.

    Collects relevant env vars (ANTHROPIC_BASE_URL, etc.) that should
    be passed through to the claude-agent-sdk subprocess.

    On Windows, auto-detects CLAUDE_CODE_GIT_BASH_PATH if not already set.

    Returns:
        Dict of env var name -> value for non-empty vars
    """
    env = {}
    for var in SDK_ENV_VARS:
        value = os.environ.get(var)
        if value:
            env[var] = value

    # On Windows, auto-detect git-bash path if not already set
    # Claude Code CLI requires bash.exe to run on Windows
    if is_windows() and "CLAUDE_CODE_GIT_BASH_PATH" not in env:
        bash_path = _find_git_bash_path()
        if bash_path:
            env["CLAUDE_CODE_GIT_BASH_PATH"] = bash_path

    # Explicitly unset PYTHONPATH in SDK subprocess environment to prevent
    # pollution of agent subprocess environments. This fixes ACS-251 where
    # external projects with different Python versions would fail due to
    # inheriting WorkPilot AI's PYTHONPATH (which points to Python 3.12 packages).
    #
    # The SDK merges os.environ with the env dict we provide, so setting
    # PYTHONPATH to an empty string here overrides any inherited value.
    # The empty string ensures Python doesn't add any extra paths to sys.path.
    env["PYTHONPATH"] = ""

    return env


def configure_sdk_authentication(config_dir: str | None = None) -> None:
    """
    Configure SDK authentication based on environment variables.

    Supports two authentication modes:
    - API Profile mode (ANTHROPIC_BASE_URL set): uses ANTHROPIC_AUTH_TOKEN
    - OAuth mode (default): uses CLAUDE_CODE_OAUTH_TOKEN

    In API profile mode, explicitly removes CLAUDE_CODE_OAUTH_TOKEN from the
    environment because the SDK gives OAuth priority over API keys when both
    are present.

    Args:
        config_dir: Optional profile config directory for per-profile Keychain
                    lookup. When set, enables multi-profile token storage.

    Raises:
        ValueError: If required tokens are missing for the active mode.
                   - API profile mode: requires ANTHROPIC_AUTH_TOKEN
                   - OAuth mode: requires CLAUDE_CODE_OAUTH_TOKEN (from Keychain or env)
    """
    # SAFETY NET (Bug #11): If both ANTHROPIC_BASE_URL and CLAUDE_CODE_OAUTH_TOKEN
    # are present WITHOUT an explicit API key, OAuth mode should take precedence.
    # The CLI's default OAuth endpoint is different from api.anthropic.com, which
    # does NOT support OAuth bearer tokens.
    # Exception: when ANTHROPIC_AUTH_TOKEN is also set, API profile mode wins.
    if (
        os.environ.get("ANTHROPIC_BASE_URL", "").strip()
        and os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
        and not os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
    ):
        stale_url = os.environ.get("ANTHROPIC_BASE_URL", "")
        logger.warning(
            "Both ANTHROPIC_BASE_URL (%s) and CLAUDE_CODE_OAUTH_TOKEN are set. "
            "Removing ANTHROPIC_BASE_URL to use OAuth authentication.",
            stale_url,
        )
        os.environ.pop("ANTHROPIC_BASE_URL", None)
        os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

    api_profile_mode = bool(os.environ.get("ANTHROPIC_BASE_URL", "").strip())

    if api_profile_mode:
        # API profile mode: ensure ANTHROPIC_AUTH_TOKEN is present
        if not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
            raise ValueError(
                "API profile mode active (ANTHROPIC_BASE_URL is set) "
                "but ANTHROPIC_AUTH_TOKEN is not set"
            )
        # Explicitly remove CLAUDE_CODE_OAUTH_TOKEN so SDK uses ANTHROPIC_AUTH_TOKEN
        # SDK gives OAuth priority over API keys when both are present
        os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        logger.info("Using API profile authentication")
    else:
        # OAuth mode: require and validate OAuth token
        # Get OAuth token - uses profile-specific Keychain lookup when config_dir is set
        # This correctly reads from "Claude Code-credentials-{hash}" for non-default profiles
        oauth_token = require_auth_token(config_dir)

        # An encrypted token (enc:...) cannot be used: refuse it before the SDK does
        validate_token_not_encrypted(oauth_token)

        # Ensure SDK can access it via its expected env var
        # This is required because the SDK doesn't know about per-profile Keychain naming
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = oauth_token

        # IMPORTANT: Avoid printing words like "invalid", "401", "authentication_error"
        # in stdout — the frontend's auth failure detector scans process output and
        # those keywords would cause FALSE POSITIVE auth failure detection.
        # We log only presence/length, never any token-derived bytes.
        logger.info(
            "Using OAuth authentication (token: %s, config_dir: %s)",
            _token_presence(oauth_token),
            config_dir or "(default)",
        )


def ensure_claude_code_oauth_token() -> None:
    """
    Ensure CLAUDE_CODE_OAUTH_TOKEN is set (for SDK compatibility).

    If not set but other auth tokens are available, copies the value
    to CLAUDE_CODE_OAUTH_TOKEN so the underlying SDK can use it.
    """
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return

    token = get_auth_token()
    if token:
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token
