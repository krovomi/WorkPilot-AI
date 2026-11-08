#!/usr/bin/env python3
"""
Code Migration Agent Runner

Automates framework, version, and language migrations.
Examples:
  - "Migrate React Class Components to Hooks"
  - "Upgrade Python 3.9 to 3.12 syntax"
  - "Convert this JS module to TypeScript"

Analyzes the code, plans the migration, executes in batches, and validates with QA.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from migration.orchestrator import MigrationOrchestrator


class CodeMigrationRunner:
    """Runner for the Code Migration Agent feature."""

    def __init__(
        self,
        project_dir: str,
        migration_description: str,
        model: str | None = None,
        thinking_level: str | None = None,
        dry_run: bool = False,
        batch_size: int = 10,
    ):
        self.project_dir = Path(project_dir)
        self.migration_description = migration_description
        self.model = model
        self.thinking_level = thinking_level or "high"
        self.dry_run = dry_run
        self.batch_size = batch_size
        self.orchestrator: MigrationOrchestrator | None = None

    def setup(self):
        """Initialize the migration orchestrator."""
        print("🚀 Initializing Code Migration Agent...")
        print(f"📁 Project: {self.project_dir}")
        print(f"🎯 Migration: {self.migration_description}")
        if self.dry_run:
            print("⚠️  Dry run mode — no files will be modified")
        self.orchestrator = MigrationOrchestrator(
            str(self.project_dir),
            enable_llm=True,
        )
        print("✅ Migration orchestrator initialized")

    def run_migration(self) -> dict:
        """Run the full migration workflow."""
        if not self.orchestrator:
            self.setup()

        print("\n📋 Phase 1: Analyzing migration scope...")
        # Parse migration description to extract source/target
        target_framework, target_language = self._parse_migration_description()

        print(
            f"   Source tech detected, target: {target_framework or 'auto'} / {target_language or 'auto'}"
        )

        source = self._describe_source_stack()

        print("\n📝 Phase 2: Generating migration plan...")
        try:
            context = self.orchestrator.start_migration(
                target_framework=target_framework or "modern",
                target_language=target_language or "auto",
            )
            plan_summary = {
                "migration_id": context.migration_id
                if hasattr(context, "migration_id")
                else "unknown",
                "source": source,
                "target": f"{target_framework or 'modern'} / {target_language or 'auto'}",
                "description": self.migration_description,
            }
        except Exception as e:
            print(f"⚠️  Migration start warning: {e}")
            plan_summary = {
                "migration_id": "fallback",
                "source": source,
                "target": f"{target_framework or 'auto'} / {target_language or 'auto'}",
                "description": self.migration_description,
                "note": str(e),
            }

        print("\n⚙️  Phase 3: Executing migration...")
        if self.dry_run:
            print("   [DRY RUN] Skipping actual file modifications")
            execution_summary = {"status": "dry_run", "files_modified": 0}
        else:
            # This runner analyses and plans; the change itself is made by a
            # Kanban task (spec, planner, coder, QA in a worktree), which the
            # page creates from the same description, for any stack.
            execution_summary = {
                "status": "not_run",
                "files_modified": 0,
                "note": "Create a Kanban task from this migration to apply it",
            }

        result = {
            "status": "success",
            "migration_description": self.migration_description,
            "dry_run": self.dry_run,
            "plan": plan_summary,
            "execution": execution_summary,
            "summary": self._generate_summary(plan_summary, execution_summary),
        }
        return result

    def _describe_source_stack(self) -> str:
        """The project's languages and frameworks, for every stack.

        Read from the shared stack facade rather than the migration analyzer,
        which only knows the JavaScript and Python ecosystems.
        """
        from project.stack import detect_project_stack

        stack = detect_project_stack(self.project_dir)
        parts = sorted(stack.get("languages") or []) + sorted(
            stack.get("frameworks") or []
        )
        return ", ".join(parts) or "unknown"

    def _parse_migration_description(self):
        """Parse migration description to infer target framework and language."""
        desc = self.migration_description.lower()
        framework = None
        language = None

        framework_keywords = {
            "hooks": "react-hooks",
            "react hooks": "react-hooks",
            "typescript": "typescript",
            "python 3.1": "python3.12",
            "python 3.11": "python3.12",
            "python 3.10": "python3.12",
            "vue 3": "vue3",
            "angular": "angular",
            "next.js": "nextjs",
            "tailwind": "tailwindcss",
            ".net": "dotnet",
            "asp.net": "aspnetcore",
            "spring boot": "spring-boot",
            "jakarta": "jakarta-ee",
            "laravel": "laravel",
            "symfony": "symfony",
            "rails": "rails",
            "flutter": "flutter",
            "swiftui": "swiftui",
            "jetpack compose": "jetpack-compose",
            "fastapi": "fastapi",
            "vite": "vite",
            "vitest": "vitest",
        }
        language_keywords = {
            "typescript": "typescript",
            "python": "python",
            "javascript": "javascript",
            "kotlin": "kotlin",
            "java": "java",
            "c#": "csharp",
            "f#": "fsharp",
            "rust": "rust",
            "golang": "go",
            "go": "go",
            "php": "php",
            "ruby": "ruby",
            "swift": "swift",
            "dart": "dart",
        }

        for keyword, target in framework_keywords.items():
            if keyword in desc:
                framework = target
                break
        for keyword, lang in language_keywords.items():
            # Whole words: "go" must not match "google", nor "rust" "trust".
            if re.search(rf"(?<![\w]){re.escape(keyword)}(?![\w#])", desc):
                language = lang
                break

        return framework, language

    def _generate_summary(self, plan: dict, execution: dict) -> dict:
        """Generate a human-readable summary."""
        return {
            "migration_id": plan.get("migration_id", "unknown"),
            "description": self.migration_description,
            "dry_run": self.dry_run,
            # A pair the rule-based planner does not know is not a failure:
            # the Kanban task still migrates it, with the agents' own plan.
            "plan_status": "unsupported" if plan.get("note") else "ready",
            "execution_status": execution.get("status", "unknown"),
            "files_modified": execution.get("files_modified", 0),
        }


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Code Migration Agent — Automated code migrations"
    )
    parser.add_argument(
        "--project-dir",
        required=True,
        help="Project directory to migrate",
    )
    parser.add_argument(
        "--migration-description",
        required=True,
        help='Description of the migration (e.g., "Migrate React Class Components to Hooks")',
    )
    parser.add_argument("--model", help="AI model to use")
    parser.add_argument(
        "--thinking-level",
        default="high",
        choices=["none", "low", "medium", "high", "ultrathink"],
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Analyze only, do not modify files",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=10,
        help="Number of files to migrate per batch (default: 10)",
    )

    args = parser.parse_args()

    if not os.path.exists(args.project_dir):
        print(f"❌ Project directory not found: {args.project_dir}")
        sys.exit(1)

    try:
        runner = CodeMigrationRunner(
            project_dir=args.project_dir,
            migration_description=args.migration_description,
            model=args.model,
            thinking_level=args.thinking_level,
            dry_run=args.dry_run,
            batch_size=args.batch_size,
        )
        runner.setup()
        result = runner.run_migration()

        print("__MIGRATION_RESULT__:" + json.dumps(result))
        print("\n✅ Migration analysis complete!")
    except KeyboardInterrupt:
        print("\n⚠️ Migration interrupted.")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
