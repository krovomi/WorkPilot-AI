"""
Context Package
===============

Task context building for autonomous coding.
"""

from .builder import ContextBuilder
from .categorizer import FileCategorizer
from .keyword_extractor import KeywordExtractor
from .memory_hints import fetch_graph_hints, is_memory_enabled
from .models import FileMatch, TaskContext
from .pattern_discovery import PatternDiscoverer
from .search import CodeSearcher
from .serialization import load_context, save_context, serialize_context
from .service_matcher import ServiceMatcher

__all__ = [
    # Main builder
    "ContextBuilder",
    # Models
    "FileMatch",
    "TaskContext",
    # Components
    "CodeSearcher",
    "ServiceMatcher",
    "KeywordExtractor",
    "FileCategorizer",
    "PatternDiscoverer",
    # Hints from the shared brain
    "fetch_graph_hints",
    "is_memory_enabled",
    # Serialization
    "serialize_context",
    "save_context",
    "load_context",
]
