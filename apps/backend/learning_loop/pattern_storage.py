"""
Pattern Storage for the Autonomous Agent Learning Loop.

The learning loop's patterns live in the project's memory in the shared brain
(`brain.project_memory`): one note per pattern under
``knowledge/projects/<project>/memory/patterns/<pattern_id>.md``, the pattern
and its evidence — confidence, occurrences, applications, successes, source
builds — in the frontmatter (``learning:``). The Memories tab, ``brain_recall``,
Obsidian and the context mesh read the same notes the prompts are built from.

They used to live in ``.workpilot/learning_loop/patterns.json``, a second
pattern store beside the vault, injected into the same prompts. That file is
imported on first use and moved aside, never deleted — into
``.workpilot/learning/`` (``patterns.json.migrated-to-brain``), the one folder
the learning loop keeps under ``.workpilot/`` (`foundation.workpilot_layout`).

Handles deduplication by merging similar patterns and increasing confidence.
When memory is off (``BRAIN_ENABLED=false``) there is nowhere to remember:
reads are empty and writes are dropped, like every other memory.
"""

import json
import logging
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .models import LearningPattern

logger = logging.getLogger(__name__)

LEGACY_PATTERNS = Path(".workpilot") / "learning_loop" / "patterns.json"
"""The store the patterns had before the vault, relative to the project."""

LEGACY_MIGRATED_SUFFIX = ".migrated-to-brain"

LEARNING_DIR = Path(".workpilot") / "learning"
"""The learning loop's one folder under ``.workpilot/`` (conventions, and the
old pattern file once migrated)."""


def _evidence(pattern: LearningPattern) -> dict[str, Any]:
    data = pattern.to_dict()
    data.pop("effectiveness_rate", None)
    return data


def _note_body(pattern: LearningPattern) -> str:
    lines = [pattern.actionable_instruction.strip() or pattern.description.strip()]
    if pattern.description.strip() and pattern.description.strip() != lines[0]:
        lines += ["", pattern.description.strip()]
    lines += [
        "",
        f"_Learning loop — {pattern.pattern_type.value}, {pattern.agent_phase}, "
        f"confidence {pattern.confidence:.2f}, seen {pattern.occurrence_count}×._",
    ]
    return "\n".join(lines)


class PatternStorage:
    """The learning loop's patterns, in the project's memory in the vault."""

    SIMILARITY_THRESHOLD = 0.8

    def __init__(self, project_dir: Path | None = None, *, project: str = ""):
        """A project's patterns, by its directory or — for the HTTP API, which
        never opens a directory a client names — by its name alone (no legacy
        ``patterns.json`` is looked for then)."""
        self.project_dir = Path(project_dir) if project_dir else None
        self.project = project
        self.legacy_file = (
            self.project_dir / LEGACY_PATTERNS if self.project_dir else None
        )
        self._migration_checked = False

    # -- the store ----------------------------------------------------------

    def _memory(self):
        if self.project:
            from brain.project_memory import ProjectMemory

            memory = ProjectMemory(project=self.project)
            return memory if memory.is_enabled else None
        from memory.store import get_project_memory

        return get_project_memory(None, self.project_dir)

    def _read(self, memory) -> list[LearningPattern]:
        patterns = []
        for data in memory.learned_patterns():
            try:
                patterns.append(LearningPattern.from_dict(data))
            except (TypeError, ValueError) as e:
                logger.warning(f"Skipping an unreadable learning pattern: {e}")
        return patterns

    def _write(
        self, memory, patterns: list[LearningPattern], *, sync: bool = True
    ) -> bool:
        """Write the patterns that changed, forget the ones that are gone."""
        current = {p.pattern_id: _evidence(p) for p in self._read(memory)}
        ok = True
        wanted = set()
        for pattern in patterns:
            wanted.add(pattern.pattern_id)
            evidence = _evidence(pattern)
            if current.get(pattern.pattern_id) == evidence:
                continue
            title = pattern.description.strip() or pattern.actionable_instruction
            written = memory.record_learned_pattern(
                evidence, title=title[:80], body=_note_body(pattern)
            )
            ok = ok and written is not None
        for gone in set(current) - wanted:
            memory.forget("pattern", gone)
        if sync:
            ok = memory.flush() and ok
        return ok

    def _migrate_legacy(self, memory) -> None:
        """Import ``patterns.json`` into the vault once, then move it aside."""
        if self._migration_checked:
            return
        self._migration_checked = True
        if self.legacy_file is None or not self.legacy_file.is_file():
            return
        try:
            raw = json.loads(self.legacy_file.read_text(encoding="utf-8"))
            items = raw.get("patterns", []) if isinstance(raw, dict) else raw
            legacy = [LearningPattern.from_dict(p) for p in items]
        except (OSError, ValueError, TypeError) as e:
            logger.warning(f"Learning patterns not migrated ({self.legacy_file}): {e}")
            return
        known = {p.pattern_id: p for p in self._read(memory)}
        for pattern in legacy:
            known.setdefault(pattern.pattern_id, pattern)
        if not self._write(memory, list(known.values())):
            logger.warning("Learning patterns not migrated: the vault write failed")
            return
        from foundation.workpilot_layout import move_aside

        target = move_aside(
            self.legacy_file, self.project_dir / LEARNING_DIR, LEGACY_MIGRATED_SUFFIX
        )
        logger.info(
            f"Learning patterns: {len(legacy)} moved into the shared brain; "
            f"the old file is kept as {target.name}"
        )

    def _open(self):
        memory = self._memory()
        if memory is not None:
            self._migrate_legacy(memory)
        return memory

    # -- the API the learning loop has always had ---------------------------

    def load_patterns(self) -> list[LearningPattern]:
        """Load all patterns from the vault."""
        memory = self._open()
        if memory is None:
            return []
        try:
            return self._read(memory)
        except Exception as e:  # noqa: BLE001 - patterns never fail a build
            logger.warning(f"Failed to load learning patterns: {e}")
            return []

    def save_patterns(
        self, patterns: list[LearningPattern], *, sync: bool = True
    ) -> None:
        """Save all patterns to the vault (one sync unless ``sync=False``)."""
        memory = self._open()
        if memory is None:
            return
        self._write(memory, patterns, sync=sync)

    def add_patterns(
        self, new_patterns: list[LearningPattern]
    ) -> list[LearningPattern]:
        """Add new patterns, merging duplicates. Returns the updated list."""
        existing = self.load_patterns()
        for new_p in new_patterns:
            merged = False
            for i, existing_p in enumerate(existing):
                if self._are_similar(existing_p, new_p):
                    existing[i] = self._merge_pattern(existing_p, new_p)
                    merged = True
                    break
            if not merged:
                existing.append(new_p)
        self.save_patterns(existing)
        return existing

    def delete_pattern(self, pattern_id: str) -> bool:
        """Delete a pattern by ID. Returns True if found and deleted."""
        patterns = self.load_patterns()
        original_len = len(patterns)
        patterns = [p for p in patterns if p.pattern_id != pattern_id]
        if len(patterns) < original_len:
            self.save_patterns(patterns)
            return True
        return False

    def toggle_pattern(self, pattern_id: str) -> bool | None:
        """Toggle a pattern's enabled state. Returns new state or None if not found."""
        patterns = self.load_patterns()
        for p in patterns:
            if p.pattern_id == pattern_id:
                p.enabled = not p.enabled
                self.save_patterns(patterns)
                return p.enabled
        return None

    def get_patterns_for_phase(
        self, phase: str, min_confidence: float = 0.5
    ) -> list[LearningPattern]:
        """Get enabled patterns for a specific agent phase above confidence threshold."""
        patterns = self.load_patterns()
        return [
            p
            for p in patterns
            if p.enabled and p.agent_phase == phase and p.confidence >= min_confidence
        ]

    def get_top_patterns(
        self, limit: int = 10, min_confidence: float = 0.6
    ) -> list[LearningPattern]:
        """Get the top N patterns by confidence, filtered by minimum confidence."""
        patterns = self.load_patterns()
        filtered = [p for p in patterns if p.enabled and p.confidence >= min_confidence]
        filtered.sort(key=lambda p: p.confidence, reverse=True)
        return filtered[:limit]

    def record_application(self, pattern_ids: list[str]) -> None:
        """Increment applied_count for the given patterns.

        Called each time a prompt carries them, so it writes the notes and
        leaves the commit to the next memory sync rather than pushing per prompt.
        """
        patterns = self.load_patterns()
        changed = False
        for p in patterns:
            if p.pattern_id in pattern_ids:
                p.applied_count += 1
                changed = True
        if changed:
            self.save_patterns(patterns, sync=False)

    def record_outcome(self, pattern_ids: list[str], success: bool) -> None:
        """Record the outcome of a build where patterns were applied."""
        if not success:
            return
        patterns = self.load_patterns()
        changed = False
        for p in patterns:
            if p.pattern_id in pattern_ids:
                p.success_after_apply += 1
                changed = True
        if changed:
            self.save_patterns(patterns)

    def _are_similar(self, a: LearningPattern, b: LearningPattern) -> bool:
        """Check if two patterns are similar enough to merge."""
        if a.category != b.category or a.agent_phase != b.agent_phase:
            return False
        ratio = SequenceMatcher(
            None, a.actionable_instruction, b.actionable_instruction
        ).ratio()
        return ratio >= self.SIMILARITY_THRESHOLD

    def _merge_pattern(
        self, existing: LearningPattern, new: LearningPattern
    ) -> LearningPattern:
        """Merge a new pattern into an existing one, boosting confidence."""
        existing.occurrence_count += new.occurrence_count
        # Boost confidence, capped at 0.99
        existing.confidence = min(
            0.99, existing.confidence + (1 - existing.confidence) * 0.15
        )
        existing.last_seen = new.last_seen
        # Merge source build IDs (dedup)
        for bid in new.source_build_ids:
            if bid not in existing.source_build_ids:
                existing.source_build_ids.append(bid)
        # Merge context tags
        for tag in new.context_tags:
            if tag not in existing.context_tags:
                existing.context_tags.append(tag)
        return existing
