"""
AI Resolver Module
==================

AI-based conflict resolution for the WorkPilot AI merge system.

This module provides intelligent conflict resolution using AI with
minimal context to reduce token usage and cost.

Components:
- AIResolver: Main resolver class
- ConflictContext: Minimal context for AI prompts
- create_ai_resolver: Factory for a resolver that asks the user's provider

Usage:
    from merge.ai_resolver import AIResolver, create_ai_resolver

    # Create a resolver that asks the user's provider
    resolver = create_ai_resolver(project_dir)

    # Or create with custom AI function
    resolver = AIResolver(ai_call_fn=my_ai_function)

    # Resolve a conflict
    result = resolver.resolve_conflict(conflict, baseline_code, task_snapshots)
"""

from .client import create_ai_resolver
from .context import ConflictContext
from .resolver import AIResolver

__all__ = [
    "AIResolver",
    "ConflictContext",
    "create_ai_resolver",
]
