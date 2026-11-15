"""
Analysis Module
===============

Code analysis and project scanning tools.
"""

# Import from analyzers subpackage (these are the modular analyzers)

from __future__ import annotations

from .analyzers import (
    ProjectAnalyzer as ModularProjectAnalyzer,
)
from .analyzers import (
    ServiceAnalyzer,
    analyze_project,
    analyze_service,
)
from .ci_discovery import CIDiscovery
from .test_discovery import TestDiscovery

# insight_extractor is a module with functions, not a class, so don't import it here
# Import it directly when needed: from analysis import insight_extractor

__all__ = [
    "ModularProjectAnalyzer",
    "ServiceAnalyzer",
    "analyze_project",
    "analyze_service",
    "CIDiscovery",
    "TestDiscovery",
]
