"""
Provider Factory
================

Factory functions for creating git provider instances.
Supports dynamic provider registration for extensibility.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .github_provider import GitHubProvider
from .protocol import GitProvider, ProviderType

# Provider registry for dynamic registration
_PROVIDER_REGISTRY: dict[ProviderType, Callable[..., GitProvider]] = {}

# The forges the protocol names that have no built-in provider yet.
_PLANNED = {
    ProviderType.GITLAB: "GitLab",
    ProviderType.BITBUCKET: "Bitbucket",
    ProviderType.GITEA: "Gitea",
    ProviderType.AZURE_DEVOPS: "Azure DevOps",
}


def register_provider(
    provider_type: ProviderType,
    factory: Callable[..., GitProvider],
) -> None:
    """
    Register a provider factory.

    Args:
        provider_type: The provider type to register
        factory: Factory function that creates provider instances

    Example:
        def create_gitlab(repo: str, **kwargs) -> GitLabProvider:
            return GitLabProvider(repo=repo, **kwargs)

        register_provider(ProviderType.GITLAB, create_gitlab)
    """
    _PROVIDER_REGISTRY[provider_type] = factory


def get_provider(
    provider_type: ProviderType | str,
    repo: str,
    **kwargs: Any,
) -> GitProvider:
    """
    Get a provider instance by type.

    Args:
        provider_type: The provider type (github, gitlab, etc.)
        repo: Repository in owner/repo format
        **kwargs: Additional provider-specific arguments

    Returns:
        GitProvider instance

    Raises:
        ValueError: If provider type is not supported

    Example:
        provider = get_provider("github", "owner/repo")
        pr = await provider.fetch_pr(123)
    """
    # A ProviderType is a str too: one conversion covers both.
    try:
        provider_type = ProviderType(provider_type.lower())
    except ValueError:
        raise ValueError(
            f"Unknown provider type: {provider_type}. "
            f"Supported: {[p.value for p in ProviderType]}"
        )

    # Check registry first
    if provider_type in _PROVIDER_REGISTRY:
        return _PROVIDER_REGISTRY[provider_type](repo=repo, **kwargs)

    # Built-in providers
    if provider_type == ProviderType.GITHUB:
        return GitHubProvider(_repo=repo, **kwargs)

    # Future providers (not yet implemented)
    raise NotImplementedError(
        f"{_PLANNED[provider_type]} provider not yet implemented. "
        f"See providers/{provider_type.value}_provider.py.stub for interface."
    )


def list_available_providers() -> list[ProviderType]:
    """
    List all available provider types.

    Returns:
        List of available ProviderType values
    """
    available = [ProviderType.GITHUB]  # Built-in

    # Add registered providers
    for provider_type in _PROVIDER_REGISTRY:
        if provider_type not in available:
            available.append(provider_type)

    return available


def is_provider_available(provider_type: ProviderType | str) -> bool:
    """
    Check if a provider is available.

    Args:
        provider_type: The provider type to check

    Returns:
        True if the provider is available
    """
    try:
        provider_type = ProviderType(provider_type.lower())
    except ValueError:
        return False

    # GitHub is always available
    if provider_type == ProviderType.GITHUB:
        return True

    # Check registry
    return provider_type in _PROVIDER_REGISTRY
