"""HTTP routes for the Domain-Specific Agent Factory.

Mounted at `/api/domain-agents`. Five endpoints:

* `GET  /domains`              — list available domains (UI dropdown)
* `GET  /profile/{domain}`     — full profile for one domain
* `POST /build`                — compose a bundle for (domain, role)
* `POST /project`              — the domain saved for a project, and its stacks
* `POST /project/set`          — save (or clear) a project's domain
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Path
from foundation.api_safety import safe_error, validated_dir
from project.stack import detect_languages
from pydantic import BaseModel, Field

from .factory import DomainAgentFactory
from .project_domain import read_project_domain, write_project_domain

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/domain-agents", tags=["domain-agents"])


class BuildRequest(BaseModel):
    domain: str = Field(..., description="Domain tag, e.g. 'fintech', 'healthcare'.")
    role: str = Field(
        ..., description="Agent role: 'coder' | 'planner' | 'reviewer' | 'documenter'."
    )
    project_path: str | None = Field(
        None,
        description="When given, library advice follows this project's stacks.",
    )


class ProjectRequest(BaseModel):
    project_path: str = Field(..., description="Absolute path to the project root.")


class SetProjectDomainRequest(ProjectRequest):
    domain: str | None = Field(
        None, description="Domain tag to apply; null or 'generic' clears it."
    )


@router.get("/domains")
def list_domains():
    try:
        return {"success": True, "domains": DomainAgentFactory().list_domains()}
    except Exception as e:  # noqa: BLE001
        logger.exception("list_domains failed")
        return {"success": False, "error": safe_error(e, logger, "list_domains")}


@router.get("/profile/{domain}")
def profile(domain: str = Path(..., min_length=1, max_length=64)):
    try:
        p = DomainAgentFactory().get_profile(domain)
        return {"success": True, "profile": p.to_dict()}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "profile")}
    except Exception as e:  # noqa: BLE001
        logger.exception("profile failed")
        return {"success": False, "error": safe_error(e, logger, "profile")}


@router.post("/build")
def build(req: BuildRequest):
    try:
        languages = (
            detect_languages(validated_dir(req.project_path, "project_path"))
            if req.project_path
            else None
        )
        bundle = DomainAgentFactory().build(req.domain, req.role, languages)
        return {"success": True, "bundle": bundle.to_dict()}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "build")}
    except Exception as e:  # noqa: BLE001
        logger.exception("build failed")
        return {"success": False, "error": safe_error(e, logger, "build")}


@router.post("/project")
def project_domain(req: ProjectRequest):
    """The domain every task of the project gets, unless its spec names one."""
    try:
        path = validated_dir(req.project_path, "project_path")
        return {
            "success": True,
            "domain": read_project_domain(path),
            "languages": detect_languages(path),
        }
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "project_domain")}
    except OSError as e:
        logger.exception("project_domain failed")
        return {"success": False, "error": safe_error(e, logger, "project_domain")}


@router.post("/project/set")
def set_project_domain(req: SetProjectDomainRequest):
    """Apply a domain to the project's agents (planner, coder, QA), or clear it."""
    try:
        path = validated_dir(req.project_path, "project_path")
        return {"success": True, "domain": write_project_domain(path, req.domain)}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "set_project_domain")}
    except OSError as e:
        logger.exception("set_project_domain failed")
        return {"success": False, "error": safe_error(e, logger, "set_project_domain")}
