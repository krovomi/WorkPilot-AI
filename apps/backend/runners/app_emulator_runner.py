"""
App Emulator Runner — Detects project type and start command for preview.

Analyzes the project directory to determine the application type,
framework, start command, and default port. No LLM required.

Output: __APP_EMULATOR_RESULT__:{json}
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Launched without PYTHONPATH: put the backend on the path for the detector.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app_detection import AppEmulatorRunner  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description="App Emulator — Detect project type and start command"
    )
    parser.add_argument(
        "--project-dir", required=True, help="Path to the project directory"
    )
    args = parser.parse_args()

    project_dir = args.project_dir
    if not os.path.isdir(project_dir):
        result = {"success": False, "error": f"Directory not found: {project_dir}"}
        print(f"__APP_EMULATOR_RESULT__:{json.dumps(result)}")
        sys.exit(1)

    runner = AppEmulatorRunner(project_dir)
    result = runner.detect_project_type()

    print(f"__APP_EMULATOR_RESULT__:{json.dumps(result)}")


if __name__ == "__main__":
    from core.log_redaction import install_global_redaction

    install_global_redaction()
    main()
