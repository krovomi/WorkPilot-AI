"""
LLM-Enhanced Transformer
Uses the configured provider to improve code transformation quality with
context-aware refactoring.

This module used to build `anthropic.Anthropic()` directly, which is the one
thing the repo's rules forbid outright. That path skipped the security hooks,
the tool permissions, the per-phase model and effort resolution, and every
provider that is not Anthropic — a user running on Copilot or a local model
got a hard dependency on ANTHROPIC_API_KEY and silence without it. It also
pinned a model id by hand, so it kept calling a 2024 Sonnet long after the
rest of the product had moved on.
"""

import asyncio
from pathlib import Path

from .models import TransformationResult


def _parse_json(text: str):
    """Parse a JSON body out of a model reply, or return None.

    An agent client returns prose, not a JSON-mode payload, so the reply may
    be fenced or prefaced. Tries the whole string first, then the outermost
    braces or brackets.
    """
    import json

    try:
        return json.loads(text)
    except ValueError:
        pass

    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except ValueError:
                continue
    return None


class LLMTransformer:
    """Enhance transformations with LLM intelligence."""

    def __init__(self, project_dir: str, api_key: str | None = None):
        self.project_dir = Path(project_dir)
        # Accepted and ignored: credentials are resolved by `core.client`,
        # which knows about OAuth profiles, per-provider keys and account
        # swapping. Kept in the signature so existing callers still construct.
        self.api_key = api_key

    async def _query(self, prompt: str) -> str:
        """Run one completion through the sanctioned client factory.

        Returns "" when the provider produced no text, which the caller treats
        as "leave the rule-based transformation alone" — the same fallback the
        missing-API-key branch used to provide.
        """
        from core.client import create_agent_client
        from phase_config import get_phase_model, get_phase_thinking_budget

        # Resolved, not hard-coded. The old code pinned
        # "claude-3-5-sonnet-20241022" in three places, so a user who had
        # chosen a different model or effort level got neither, and a user on
        # a non-Anthropic provider got an error.
        spec_dir = self.project_dir
        client = create_agent_client(
            project_dir=self.project_dir,
            spec_dir=spec_dir,
            model=get_phase_model(spec_dir, "coding"),
            agent_type="migration",
            max_thinking_tokens=get_phase_thinking_budget(spec_dir, "coding"),
        )

        text = ""
        async with client:
            await client.query(prompt)
            async for msg in client.receive_response():
                if type(msg).__name__ != "AssistantMessage":
                    continue
                for block in getattr(msg, "content", []) or []:
                    if type(block).__name__ == "TextBlock":
                        text += getattr(block, "text", "")
        return text.strip()

    async def enhance_transformation(
        self,
        result: TransformationResult,
        source_framework: str,
        target_framework: str,
        prompt_template: str,
    ) -> TransformationResult:
        """
        Enhance a transformation result using Claude.

        Args:
            result: Base transformation result from rule-based transformer
            source_framework: Source framework/language
            target_framework: Target framework/language
            prompt_template: Template for the LLM prompt

        Returns:
            Enhanced TransformationResult with improved code quality
        """
        try:
            # Load the prompt template
            prompt = self._build_prompt(
                result.before,
                result.after,
                source_framework,
                target_framework,
                prompt_template,
            )

            enhanced_code = await self._query(prompt)
            if not enhanced_code:
                return result

            # Update the result
            result.after = enhanced_code
            result.confidence = min(result.confidence + 0.1, 0.99)
            result.llm_enhanced = True

            return result

        except Exception as e:
            result.errors.append(f"LLM enhancement error: {str(e)}")
            return result

    async def enhance_transformations_batch(
        self,
        results: list[TransformationResult],
        source_framework: str,
        target_framework: str,
        prompt_template: str,
        max_concurrent: int = 3,
    ) -> list[TransformationResult]:
        """
        Enhance multiple transformations in parallel.

        Args:
            results: List of transformation results
            source_framework: Source framework
            target_framework: Target framework
            prompt_template: Template for prompts
            max_concurrent: Max concurrent LLM calls

        Returns:
            List of enhanced results
        """
        semaphore = asyncio.Semaphore(max_concurrent)

        async def enhance_with_limit(result: TransformationResult):
            async with semaphore:
                return await self.enhance_transformation(
                    result, source_framework, target_framework, prompt_template
                )

        tasks = [enhance_with_limit(r) for r in results]
        return await asyncio.gather(*tasks)

    def _build_prompt(
        self,
        original_code: str,
        transformed_code: str,
        source_framework: str,
        target_framework: str,
        template: str,
    ) -> str:
        """Build the LLM prompt from template."""
        # Load prompt template
        prompt_file = self.project_dir.parent / "prompts" / template

        if prompt_file.exists():
            base_prompt = prompt_file.read_text(encoding="utf-8")
        else:
            # Fallback generic prompt
            base_prompt = self._get_generic_prompt()

        # Fill in the template
        prompt = (
            base_prompt
            + f"""

## Original Code ({source_framework}):
```
{original_code}
```

## Initial Transformation ({target_framework}):
```
{transformed_code}
```

## Task
Review and enhance the transformation above. Make sure:
1. All logic is correctly preserved
2. Best practices for {target_framework} are followed
3. Edge cases are handled properly
4. Code is idiomatic and clean
5. Comments explain complex transformations

Return ONLY the enhanced {target_framework} code without any markdown formatting or explanations.
"""
        )
        return prompt

    def _get_generic_prompt(self) -> str:
        """Generic fallback prompt."""
        return """You are an expert software engineer specializing in code migration and refactoring.

Your task is to review and enhance code transformations between different frameworks/languages.
Ensure the transformation:
- Preserves all original functionality
- Follows target framework best practices
- Handles edge cases
- Is idiomatic and maintainable
"""

    async def validate_transformation(
        self, result: TransformationResult, test_files: list[str] | None = None
    ) -> bool:
        """
        Use LLM to validate if transformation is correct.

        Args:
            result: Transformation result to validate
            test_files: Optional related test files for context

        Returns:
            True if validation passes
        """
        try:
            prompt = f"""Review this code transformation and determine if it's correct.

Original Code:
```
{result.before}
```

Transformed Code:
```
{result.after}
```

Analyze:
1. Is the logic preserved?
2. Are there any bugs introduced?
3. Does it follow best practices?
4. Are edge cases handled?

Respond with JSON:
{{
    "valid": true/false,
    "confidence": 0.0-1.0,
    "issues": ["list of issues if any"],
    "suggestions": ["list of improvement suggestions"]
}}
"""

            raw = await self._query(prompt)
            if not raw:
                return False

            validation = _parse_json(raw)
            if validation is None:
                result.errors.append("Validation response was not valid JSON")
                return False

            result.validation_passed = validation.get("valid", False)
            result.confidence = validation.get("confidence", result.confidence)

            if validation.get("issues"):
                result.errors.extend(validation["issues"])

            return validation.get("valid", False)

        except Exception as e:
            result.errors.append(f"Validation error: {str(e)}")
            return False

    async def suggest_manual_changes(
        self, result: TransformationResult
    ) -> list[dict[str, str]]:
        """
        Generate suggestions for manual review.

        Returns:
            List of suggestions with line numbers and descriptions
        """
        try:
            prompt = f"""Analyze this code transformation and identify parts that need manual review.

Original:
```
{result.before}
```

Transformed:
```
{result.after}
```

Identify areas that:
1. Might need manual verification
2. Have complex logic that's hard to auto-migrate
3. Could have multiple valid approaches
4. Require domain knowledge

Return JSON array:
[
    {{
        "line_number": 10,
        "description": "Complex async logic - verify behavior",
        "severity": "high|medium|low"
    }}
]
"""

            raw = await self._query(prompt)
            if not raw:
                return []

            suggestions = _parse_json(raw)
            return suggestions if isinstance(suggestions, list) else []

        except Exception as e:
            return [
                {
                    "line_number": 0,
                    "description": f"Error: {str(e)}",
                    "severity": "high",
                }
            ]
