"""HTTP routes for the Cognitive Context Optimizer.

Mounted at `/api/cognitive-context`. One endpoint:

* `POST /optimize` — score + slice + pack candidate files into a token budget.

Every file read is inside the project the caller names: a candidate that
resolves elsewhere is refused (``refused``), never opened. With no
candidates, the project's own sources are proposed (``discovered``).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from foundation.api_safety import safe_error, validated_dir
from pydantic import BaseModel, Field

from .optimizer import CognitiveContextOptimizer
from .project_files import discover_candidates, resolve_candidates

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cognitive-context", tags=["cognitive-context"])


class OptimizeRequest(BaseModel):
    prompt: str = Field("", description="The user task or instruction.")
    candidate_files: list[str] = Field(
        default_factory=list,
        max_length=2_000,
        description=(
            "Paths relative to project_dir (or absolute, inside it). Empty: "
            "the project's sources are proposed."
        ),
    )
    project_dir: str = Field(..., description="The project whose files are read.")
    token_budget: int = Field(8_000, ge=100, le=200_000)
    explicit_mentions: list[str] | None = Field(
        None, description="Filenames the prompt explicitly names — boosted heavily."
    )
    recent_files: list[str] | None = Field(
        None, description="Recently-edited paths — modest score boost."
    )


@router.post("/optimize")
def optimize(req: OptimizeRequest):
    try:
        project_dir = validated_dir(req.project_dir, "project_dir")
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "optimize")}

    try:
        discovered = not req.candidate_files
        if discovered:
            candidates, refused = discover_candidates(project_dir, req.prompt), []
        else:
            candidates, refused = resolve_candidates(project_dir, req.candidate_files)
        engine = CognitiveContextOptimizer(project_dir=project_dir)
        result = engine.optimize(
            prompt=req.prompt,
            candidate_files=candidates,
            token_budget=req.token_budget,
            explicit_mentions=req.explicit_mentions,
            recent_files=req.recent_files,
        )
        return {
            "success": True,
            "context": {
                **result.to_dict(),
                "discovered": discovered,
                "refused": [r.to_dict() for r in refused],
            },
        }
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "optimize")}
    except OSError as e:
        return {"success": False, "error": safe_error(e, logger, "optimize")}
