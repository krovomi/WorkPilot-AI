"""Best-effort, bounded local observations; never an approval source."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import get_args

from .models import WORKFLOW_ID, BypassReason, finite_number

logger = logging.getLogger(__name__)
_MAX_BYTES = 256 * 1024


def write_observation(directory: Path, record: dict) -> None:
    temporary = None
    try:
        data = json.dumps(record, ensure_ascii=False, allow_nan=False)
        if len(data.encode("utf-8")) > _MAX_BYTES:
            return
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, prefix=".jev-", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        os.replace(temporary, directory / "jev-evaluations.json")
    except (OSError, ValueError, TypeError):
        logger.debug("JEV observation could not be saved")
    finally:
        if temporary:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def read_observations(directory: Path) -> dict | None:
    try:
        with (directory / "jev-evaluations.json").open("rb") as handle:
            data = handle.read(_MAX_BYTES + 1)
        if len(data) > _MAX_BYTES:
            return None
        raw = json.loads(data)
        if (
            not isinstance(raw, dict)
            or raw.get("version") != 1
            or not isinstance(raw.get("runId"), str)
            or len(raw["runId"]) > 100
        ):
            return None
        workflow = raw.get("workflow")
        if not isinstance(workflow, str) or not WORKFLOW_ID.fullmatch(workflow):
            return None
        records = raw.get("evaluations")
        if not isinstance(records, list) or len(records) > 50:
            return None
        clean = []
        for row in records:
            if (
                not isinstance(row, dict)
                or row.get("status") not in ("evaluated", "bypassed")
                or row.get("point") not in ("classification", "review")
            ):
                return None
            if row.get("reason") is not None and row["reason"] not in get_args(
                BypassReason
            ):
                return None
            if any(
                not isinstance(row.get(key), str) or len(row[key]) > 160
                for key in ("passId", "revision", "createdAt")
            ):
                return None
            answers = row.get("answers", {})
            if not isinstance(answers, dict):
                return None
            for name, answer in answers.items():
                if name not in ("task_class", "coverage", "risk") or not isinstance(
                    answer, dict
                ):
                    return None
                value = answer.get("value")
                if not (
                    finite_number(value)
                    or value
                    in (
                        "trivial",
                        "simple_edit",
                        "multi_file",
                        "architecture",
                        "review",
                        "planning",
                        "ideation",
                        "documentation",
                    )
                ):
                    return None
                if answer.get("confidence") is not None and (
                    not finite_number(answer["confidence"])
                    or not 0 <= answer["confidence"] <= 1
                ):
                    return None
            clean.append(
                {
                    key: row.get(key)
                    for key in (
                        "point",
                        "passId",
                        "revision",
                        "status",
                        "reason",
                        "answers",
                        "model",
                        "usage",
                        "createdAt",
                    )
                }
            )
        return {
            "version": 1,
            "runId": raw["runId"],
            "workflow": workflow,
            "evaluations": clean,
        }
    except (OSError, ValueError, TypeError, RecursionError):
        return None
