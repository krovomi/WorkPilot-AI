"""Authors an architecture model from a specification and project analysis.

This module handles the multi-step process of creating and validating an
architecture model, including prompting a language model to generate initial
model text, validating the output, and delivering the final artifact.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import cli

logger = logging.getLogger(__name__)


class AuthoringError(Exception):
    """Raised when the authoring process fails."""

    pass


def build_prompt(
    project_dir: Path,
    spec_content: str,
    analysis: str,
    effort: str = "medium",
) -> str:
    """Build a prompt for the model to author the architecture model.

    Args:
        project_dir: Path to the project directory.
        spec_content: The specification content from spec.md.
        analysis: Analysis of the project structure.
        effort: The effort level for the task (low, medium, high).

    Returns:
        A prompt string for the model to author the architecture.
    """
    return f"""
    You are authoring an architecture model for the following project:
    Project: {project_dir.name}
    Effort: {effort}

    Specification:
    {spec_content}

    Project Analysis:
    {analysis}

    Please generate an architecture model based on the above information.
    """


async def author(
    session: Any,
    project_dir: Path,
    spec_dir: Path,
    model: str,
    effort: str = "medium",
) -> dict[str, Any]:
    """Author an architecture model.

    This process:
    1. Builds a prompt from the project specification and analysis
    2. Runs the prompt through an LLM session to generate model text
    3. Validates the generated model
    4. Delivers the final artifact

    Args:
        session: The agent session to use for authoring.
        project_dir: Path to the project directory.
        spec_dir: Path to the specification directory.
        model: The model to use for authoring.
        effort: The effort level for the task.

    Returns:
        The result of the authoring process.

    Raises:
        AuthoringError: If any step of the authoring process fails.
    """
    try:
        # Load the specification
        spec_file = spec_dir / "spec.md"
        if not spec_file.exists():
            raise AuthoringError(f"Specification file not found: {spec_file}")

        spec_content = spec_file.read_text(encoding="utf-8")

        # Build the prompt
        prompt = build_prompt(
            project_dir=project_dir,
            spec_content=spec_content,
            analysis="",  # This would be populated from actual analysis
            effort=effort,
        )

        # Run the authoring session
        logger.info("Starting authoring session for %s", project_dir.name)
        status, response, _ = await session.run(
            prompt=prompt,
            model=model,
        )

        if status == "error":
            raise AuthoringError(f"Authoring session failed: {response}")

        # Parse the model from the response
        try:
            model_data = json.loads(response)
        except json.JSONDecodeError as exc:
            logger.error("Failed to parse model JSON: %s", exc)
            raise AuthoringError(f"Failed to parse generated model: {exc}") from exc

        # Validate the model
        receipt = cli.validate(model_data)
        if not receipt.ok:
            logger.warning("Model validation failed: %s", receipt.summary())
            raise AuthoringError(f"Model validation failed: {receipt.summary()}")

        # Deliver the final artifact
        output_path = spec_dir / "architecture.json"
        receipt = cli.deliver(model_data, output_path)
        if not receipt.ok:
            raise AuthoringError(f"Failed to deliver model: {receipt.summary()}")

        logger.info("Architecture model authored successfully")
        return {"success": True, "path": str(output_path)}

    except Exception as exc:
        logger.error("Authoring failed: %s", exc)
        if isinstance(exc, AuthoringError):
            raise
        raise AuthoringError(f"Unexpected error during authoring: {exc}") from exc
