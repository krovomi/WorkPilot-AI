"""
Onboarding Agent — Contextual onboarding for new team members.

Analyses the codebase to produce architecture overviews, key-file maps,
entry points, runnable commands, naming convention guides, an interactive
tour, a quiz, first tasks and a glossary.
"""

from .onboarding_engine import (
    ArchitectureNode,
    Convention,
    KeyFile,
    OnboardingEngine,
    OnboardingGuide,
    OnboardingSection,
    ProjectCommand,
    ProjectScan,
    scan_project,
)
from .tour_builder import (
    FirstTask,
    GlossaryTerm,
    OnboardingPackage,
    OnboardingPackageBuilder,
    QuizQuestion,
    TourStep,
    build_first_tasks,
    build_glossary,
    build_quiz,
    build_tour,
    render_markdown,
)

__all__ = [
    "OnboardingEngine",
    "OnboardingGuide",
    "OnboardingSection",
    "KeyFile",
    "Convention",
    "ProjectCommand",
    "ArchitectureNode",
    "ProjectScan",
    "scan_project",
    "OnboardingPackage",
    "OnboardingPackageBuilder",
    "TourStep",
    "QuizQuestion",
    "FirstTask",
    "GlossaryTerm",
    "build_tour",
    "build_quiz",
    "build_first_tasks",
    "build_glossary",
    "render_markdown",
]
