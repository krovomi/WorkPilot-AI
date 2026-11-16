#!/usr/bin/env python3
"""
Tests for QA Report - Configuration
====================================

Tests the configuration constants in qa/report.py including:
- RECURRING_ISSUE_THRESHOLD
- ISSUE_SIMILARITY_THRESHOLD
"""

import sys
from pathlib import Path

import pytest

# Import configuration constants after mocking
from qa.report import (
    ISSUE_SIMILARITY_THRESHOLD,
    RECURRING_ISSUE_THRESHOLD,
)

# =============================================================================
# FIXTURES
# =============================================================================


# =============================================================================
# CONFIGURATION TESTS
# =============================================================================


class TestConfiguration:
    """Tests for configuration values."""

    def test_recurring_threshold_default(self) -> None:
        """Test default recurring issue threshold."""
        # Le défaut a été remonté de 3 à 8 pour éviter d'escalader vers
        # une revue humaine dès la 3ᵉ itération sur 50 max.
        assert RECURRING_ISSUE_THRESHOLD == 8

    def test_recurring_threshold_is_int(self) -> None:
        """Test that recurring threshold is an integer."""
        assert isinstance(RECURRING_ISSUE_THRESHOLD, int)

    def test_similarity_threshold_default(self) -> None:
        """Test default similarity threshold."""
        assert ISSUE_SIMILARITY_THRESHOLD == 0.8
        assert 0 < ISSUE_SIMILARITY_THRESHOLD <= 1

    def test_similarity_threshold_is_float(self) -> None:
        """Test that similarity threshold is a float."""
        assert isinstance(ISSUE_SIMILARITY_THRESHOLD, float)
