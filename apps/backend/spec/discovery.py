"""
Discovery Module
================

Project structure analysis and indexing.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run_discovery_script(
    project_dir: Path,
    spec_dir: Path,
) -> tuple[bool, str]:
    """Run the analyzer.py script to discover project structure.

    Returns:
        (success, output_message)
    """
    spec_index = spec_dir / "project_index.json"
    auto_build_index = project_dir / ".workpilot" / "project_index.json"

    # Check if project_index already exists
    if auto_build_index.exists() and not spec_index.exists():
        # Copy existing index
        shutil.copy(auto_build_index, spec_index)
        return True, "Copied existing project_index.json"

    if spec_index.exists():
        return True, "project_index.json already exists"

    # Run analyzer - use framework-relative path instead of project_dir
    script_path = Path(__file__).parent.parent / "analyzer.py"
    if not script_path.exists():
        return False, f"Script not found: {script_path}"

    cmd = [sys.executable, str(script_path), "--output", str(spec_index)]

    try:
        result = subprocess.run(
            cmd,
            cwd=project_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            # The analyzer prints paths; on a Windows pipe its default cp1252
            # stdout raised on any character outside it.
            env={**os.environ, "PYTHONUTF8": "1"},
            timeout=300,
        )

        if result.returncode == 0 and spec_index.exists():
            return True, "Created project_index.json"
        else:
            return False, result.stderr or result.stdout

    except subprocess.TimeoutExpired:
        return False, "Script timed out"
    except Exception as e:
        return False, str(e)


def get_project_index_stats(spec_dir: Path) -> dict:
    """What the project index found: its services and the project type.

    It used to return a ``file_count`` estimated from the services ("3 config
    files: package.json, tsconfig.json, .env.example", "8 files per key
    directory", "1 per 2 dependencies"), logged as "Discovered N files in
    project": a number nothing had counted, with a JavaScript layout assumed
    for every stack.
    """
    spec_index = spec_dir / "project_index.json"
    try:
        index_data = json.loads(spec_index.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(index_data, dict):
        return {}
    services = index_data.get("services")
    names = sorted(services) if isinstance(services, dict) else []
    return {
        "services": names,
        "project_type": index_data.get("project_type", "unknown"),
    }
