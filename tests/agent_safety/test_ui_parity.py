"""What the app shows and checks is what the backend applies.

The Anomaly detection page lists the score impacts (`SCORED_ANOMALIES`) and
the main process checks snapshot ids (`SNAPSHOT_ID`) before the runner sees
them; both are kept in step by hand with the backend, and read here.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent_snapshots.store import _SNAPSHOT_ID
from security.agent_safety_settings import (
    MAX_ALLOWED_PATHS,
    MAX_VM_CPUS,
    MAX_VM_MEMORY_GB,
)
from security.anomaly_detector import ANOMALY_SCORE_IMPACT

FRONTEND = Path(__file__).resolve().parents[2] / "apps" / "frontend" / "src"
PAGE = (
    FRONTEND / "renderer" / "components" / "settings" / "AnomalyDetectionSettings.tsx"
)
UTILS = FRONTEND / "shared" / "utils" / "agent-safety.ts"


def test_scored_anomalies_match_the_detector() -> None:
    text = PAGE.read_text(encoding="utf-8")
    rows = re.findall(
        r'\{ type: "([a-z_]+)", severity: "[a-z]+", impact: (\d+) \}', text
    )
    assert rows, "SCORED_ANOMALIES not found"
    for anomaly_type, impact in rows:
        assert ANOMALY_SCORE_IMPACT[anomaly_type] == float(impact), anomaly_type


def test_snapshot_id_and_path_cap_match() -> None:
    text = UTILS.read_text(encoding="utf-8")
    match = re.search(r"export const SNAPSHOT_ID = /(.+)/;", text)
    assert match is not None
    assert match.group(1) == _SNAPSHOT_ID.pattern
    assert f"export const MAX_ALLOWED_PATHS = {MAX_ALLOWED_PATHS};" in text
    assert f"export const MAX_VM_MEMORY_GB = {MAX_VM_MEMORY_GB};" in text
    assert f"export const MAX_VM_CPUS = {MAX_VM_CPUS};" in text
