"""
GitHub Content Sanitization
============================

Protects against prompt injection attacks by:
- Stripping HTML comments that may contain hidden instructions
- Stripping characters a reader does not see (control, zero-width, tag)
- Enforcing content length limits
- Escaping special delimiters

Based on OWASP guidelines for LLM prompt injection prevention.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# Content length limits
MAX_ISSUE_BODY_CHARS = 10_000  # 10KB
MAX_PR_BODY_CHARS = 10_000  # 10KB
MAX_DIFF_CHARS = 100_000  # 100KB
MAX_FILE_CONTENT_CHARS = 50_000  # 50KB per file
MAX_COMMENT_CHARS = 5_000  # 5KB per comment


def _char_class(*ranges: tuple[int, int]) -> str:
    """A regex character class for the given code point ranges, both ends kept."""
    return (
        "["
        + "".join(f"{re.escape(chr(a))}-{re.escape(chr(b))}" for a, b in ranges)
        + "]"
    )


@dataclass
class SanitizeResult:
    """Result of sanitization operation."""

    content: str
    was_truncated: bool
    was_modified: bool
    removed_items: list[str]  # List of removed elements
    original_length: int
    final_length: int
    warnings: list[str]


class ContentSanitizer:
    """
    Sanitizes user-provided content to prevent prompt injection.

    Usage:
        sanitizer = ContentSanitizer()

        # Sanitize issue body
        result = sanitizer.sanitize(issue_body, content_type="issue_body")
        if result.was_modified:
            logger.warning(f"Content modified: {result.warnings}")

        # Sanitize for prompt inclusion
        safe_content = sanitizer.wrap_user_content(
            content=issue_body,
            content_type="issue_body",
        )
    """

    # Patterns for dangerous content
    HTML_COMMENT_PATTERN = re.compile(r"<!--[\s\S]*?-->", re.MULTILINE)
    SCRIPT_TAG_PATTERN = re.compile(r"<script\b[\s\S]*?</script\b[^>]*>", re.IGNORECASE)
    STYLE_TAG_PATTERN = re.compile(r"<style\b[\s\S]*?</style\b[^>]*>", re.IGNORECASE)

    # Characters a reader does not see: control characters other than tab and
    # line breaks (C0, DEL, C1, a carriage return outside CRLF), zero-width
    # characters and the Unicode tag block (U+E0000 to U+E007F)
    INVISIBLE_PATTERN = re.compile(
        "|".join(
            (
                _char_class((0x00, 0x08), (0x0B, 0x0C), (0x0E, 0x1F), (0x7F, 0x9F)),
                "\r(?!\n)",
                _char_class((0x200B, 0x200D), (0x2060, 0x2060), (0xFEFF, 0xFEFF)),
                _char_class((0xE0000, 0xE007F)),
            )
        )
    )

    # Patterns that look like prompt injection attempts
    INJECTION_PATTERNS = [
        re.compile(r"ignore\s+(previous|above|all)\s+instructions?", re.IGNORECASE),
        re.compile(r"disregard\s+(previous|above|all)\s+instructions?", re.IGNORECASE),
        re.compile(r"forget\s+(previous|above|all)\s+instructions?", re.IGNORECASE),
        re.compile(r"new\s+instructions?:", re.IGNORECASE),
        re.compile(r"system\s*:\s*", re.IGNORECASE),
        re.compile(r"<\s*system\s*>", re.IGNORECASE),
        re.compile(r"\[SYSTEM\]", re.IGNORECASE),
        re.compile(r"```system", re.IGNORECASE),
        re.compile(r"IMPORTANT:\s*ignore", re.IGNORECASE),
        re.compile(r"override\s+safety", re.IGNORECASE),
        re.compile(r"bypass\s+restrictions?", re.IGNORECASE),
        re.compile(r"you\s+are\s+now\s+", re.IGNORECASE),
        re.compile(r"pretend\s+you\s+are", re.IGNORECASE),
        re.compile(r"act\s+as\s+if\s+you", re.IGNORECASE),
    ]

    # Delimiters for wrapping user content
    USER_CONTENT_START = "<user_content>"
    USER_CONTENT_END = "</user_content>"

    # Pattern to detect delimiter variations (including spaces, unicode homoglyphs)
    USER_CONTENT_TAG_PATTERN = re.compile(
        r"<\s*/?\s*user_content\s*>",
        re.IGNORECASE,
    )

    def __init__(
        self,
        max_issue_body: int = MAX_ISSUE_BODY_CHARS,
        max_pr_body: int = MAX_PR_BODY_CHARS,
        max_diff: int = MAX_DIFF_CHARS,
        max_file: int = MAX_FILE_CONTENT_CHARS,
        max_comment: int = MAX_COMMENT_CHARS,
        log_truncation: bool = True,
        detect_injection: bool = True,
    ):
        """
        Initialize sanitizer.

        Args:
            max_issue_body: Max chars for issue body
            max_pr_body: Max chars for PR body
            max_diff: Max chars for diffs
            max_file: Max chars per file
            max_comment: Max chars per comment
            log_truncation: Whether to log truncation events
            detect_injection: Whether to detect injection patterns
        """
        self.max_issue_body = max_issue_body
        self.max_pr_body = max_pr_body
        self.max_diff = max_diff
        self.max_file = max_file
        self.max_comment = max_comment
        self.log_truncation = log_truncation
        self.detect_injection = detect_injection

    def sanitize(
        self,
        content: str,
        max_length: int | None = None,
        content_type: str = "content",
    ) -> SanitizeResult:
        """
        Sanitize content by removing dangerous elements and truncating.

        Args:
            content: Raw content to sanitize
            max_length: Maximum allowed length. Defaults to the cap this
                content type already declares, so a caller that knows the type
                does not have to repeat the number the type implies.
            content_type: Type of content for logging

        Returns:
            SanitizeResult with sanitized content and metadata
        """
        if not content:
            return SanitizeResult(
                content="",
                was_truncated=False,
                was_modified=False,
                removed_items=[],
                original_length=0,
                final_length=0,
                warnings=[],
            )

        if max_length is None:
            max_length = self._get_max_for_type(content_type)

        original_length = len(content)
        removed_items = []
        warnings = []
        was_modified = False

        # Steps 1-2: remove what a reader does not see (HTML comments,
        # invisible characters, script and style blocks). The removals repeat
        # until nothing changes: taking one block out can join the text
        # around it into another.
        counts = {"comments": 0, "invisible": 0, "script": 0, "style": 0}
        previous = None
        while content != previous:
            previous = content
            invisible = self.INVISIBLE_PATTERN.findall(content)
            if invisible:
                content = self.INVISIBLE_PATTERN.sub("", content)
                counts["invisible"] += len(invisible)
            html_comments = self.HTML_COMMENT_PATTERN.findall(content)
            if html_comments:
                content = self.HTML_COMMENT_PATTERN.sub("", content)
                removed_items.extend(
                    [f"HTML comment ({len(c)} chars)" for c in html_comments]
                )
                counts["comments"] += len(html_comments)
            script_tags = self.SCRIPT_TAG_PATTERN.findall(content)
            if script_tags:
                content = self.SCRIPT_TAG_PATTERN.sub("", content)
                counts["script"] += len(script_tags)
            style_tags = self.STYLE_TAG_PATTERN.findall(content)
            if style_tags:
                content = self.STYLE_TAG_PATTERN.sub("", content)
                counts["style"] += len(style_tags)

        if counts["comments"] and self.log_truncation:
            logger.info(
                f"Removed {counts['comments']} HTML comments from {content_type}"
            )
        if counts["invisible"]:
            removed_items.append(f"{counts['invisible']} invisible characters")
        if counts["script"]:
            removed_items.append(f"{counts['script']} script tags")
        if counts["style"]:
            removed_items.append(f"{counts['style']} style tags")
        if any(counts.values()):
            was_modified = True

        # Step 3: Detect potential injection patterns (warn only, don't remove)
        if self.detect_injection:
            for pattern in self.INJECTION_PATTERNS:
                matches = pattern.findall(content)
                if matches:
                    warning = f"Potential injection pattern detected: {pattern.pattern}"
                    warnings.append(warning)
                    if self.log_truncation:
                        logger.warning(f"{content_type}: {warning}")

        # Step 4: Escape our delimiters if present in content (handles variations)
        if self.USER_CONTENT_TAG_PATTERN.search(content):
            # Use regex to catch all variations including spacing and case
            content = self.USER_CONTENT_TAG_PATTERN.sub(
                lambda m: m.group(0).replace("<", "&lt;").replace(">", "&gt;"),
                content,
            )
            was_modified = True
            warnings.append("Escaped delimiter tags in content")

        # Step 5: Truncate if too long
        was_truncated = False
        if len(content) > max_length:
            content = content[:max_length]
            was_truncated = True
            was_modified = True
            if self.log_truncation:
                logger.info(
                    f"Truncated {content_type} from {original_length} to {max_length} chars"
                )
            warnings.append(
                f"Content truncated from {original_length} to {max_length} chars"
            )

        # Step 6: Clean up whitespace
        content = content.strip()

        return SanitizeResult(
            content=content,
            was_truncated=was_truncated,
            was_modified=was_modified,
            removed_items=removed_items,
            original_length=original_length,
            final_length=len(content),
            warnings=warnings,
        )

    def wrap_user_content(
        self,
        content: str,
        content_type: str = "content",
        sanitize_first: bool = True,
        max_length: int | None = None,
    ) -> str:
        """
        Wrap user content with delimiters for safe prompt inclusion.

        Args:
            content: Content to wrap
            content_type: Type for logging and sanitization
            sanitize_first: Whether to sanitize before wrapping
            max_length: Override max length

        Returns:
            Wrapped content safe for prompt inclusion
        """
        if sanitize_first:
            max_len = max_length or self._get_max_for_type(content_type)
            result = self.sanitize(content, max_len, content_type)
            content = result.content

        return f"{self.USER_CONTENT_START}\n{content}\n{self.USER_CONTENT_END}"

    def _get_max_for_type(self, content_type: str) -> int:
        """Get max length for content type."""
        type_map = {
            "issue_body": self.max_issue_body,
            "pr_body": self.max_pr_body,
            "diff": self.max_diff,
            "file": self.max_file,
            "comment": self.max_comment,
        }
        return type_map.get(content_type, self.max_issue_body)


_sanitizer: ContentSanitizer | None = None


def get_sanitizer() -> ContentSanitizer:
    """Get global sanitizer instance."""
    global _sanitizer
    if _sanitizer is None:
        _sanitizer = ContentSanitizer()
    return _sanitizer
