"""Requirements and acceptance criteria proposed from an attached specification.

A person who attaches the customer's specification — often a scanned PDF,
sometimes a photo of a printed page — has already written the requirements
once. What reached the spec pipeline was the one-line task title: the spec
writer invented requirements the document stated, in other words, and QA held
the build to those.

This module reads the text `preflight` extracted (the text layer of a PDF, or
the OCR of its pages) and proposes, without a model:

- **requirements** — sentences that state an obligation (`shall`, `must`,
  `doit`, `devra`…) or carry the document's own reference (`REQ-12`, `EF-03`,
  `Exigence 4`), each given the next free `FR-###` / `NFR-###`;
- **acceptance criteria** — Given/When/Then scenarios (`Étant donné`/`Quand`/
  `Alors` too) and the bullets under an "acceptance criteria" heading;
- **rule tables** — `tables.py`, with the parametrised test each one is.

**Nothing is added without a person saying yes.** A proposal is a line in
`<spec_dir>/docintel/drafts.json`; `decide` is the only writer of `spec.md`,
and it writes what the person accepted, as they edited it. A heuristic that
wrote requirements straight into the spec would make every false positive a
requirement QA holds the build to — the guess reading exactly like a decision,
which is what `[NEEDS CLARIFICATION]` exists to prevent.

**A decision is remembered.** Proposals are keyed by their normalised text, so
reading the attachments again — the next build, a second click — keeps what
was accepted and never re-proposes what was rejected.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .files import writable
from .tables import RuleTable, TestDraft, drafts_for, project_languages

logger = logging.getLogger(__name__)

RESULT_DIR = "docintel"
DRAFTS_FILE = "drafts.json"
SECTION_TITLE = "Requirements from attachments"
CRITERIA_SUBTITLE = "Acceptance criteria from attachments"
MAX_REQUIREMENTS = 60
MAX_CRITERIA = 40
MIN_CHARS = 15
MAX_CHARS = 400
#: What the person may send back for one line: an edit, not a document.
MAX_EDIT_CHARS = 600

STATUSES = ("proposed", "accepted", "rejected")


@dataclass
class RequirementDraft:
    #: Stable across readings: a hash of the normalised text.
    key: str
    #: The id it would get — provisional until accepted, when the next free id
    #: in `spec.md` at that moment is taken instead.
    id: str
    kind: str
    text: str
    source: str
    page: int = 0
    #: The document's own reference (`REQ-12`, `EF-03`), "" when none.
    ref: str = ""
    status: str = "proposed"


@dataclass
class CriterionDraft:
    key: str
    text: str
    source: str
    page: int = 0
    status: str = "proposed"


@dataclass
class TableDraft:
    key: str
    table: RuleTable
    source: str
    tests: list[TestDraft] = field(default_factory=list)
    #: ``proposed`` (in the prompt) or ``rejected`` (the person dismissed it).
    status: str = "proposed"

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "table": self.table.to_dict(),
            "source": self.source,
            "tests": [t.to_dict() for t in self.tests],
            "status": self.status,
        }


@dataclass
class DraftSet:
    requirements: list[RequirementDraft] = field(default_factory=list)
    criteria: list[CriterionDraft] = field(default_factory=list)
    tables: list[TableDraft] = field(default_factory=list)
    #: Attachments that were read, relative to the spec directory.
    sources: list[str] = field(default_factory=list)
    generated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "requirements": [asdict(r) for r in self.requirements],
            "criteria": [asdict(c) for c in self.criteria],
            "tables": [t.to_dict() for t in self.tables],
            "sources": list(self.sources),
            "generated_at": self.generated_at,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> DraftSet:
        def pick(model, item: dict):
            return model(
                **{k: v for k, v in item.items() if k in model.__dataclass_fields__}
            )

        tables: list[TableDraft] = []
        for item in payload.get("tables") or []:
            if not isinstance(item, dict) or not isinstance(item.get("table"), dict):
                continue
            tables.append(
                TableDraft(
                    key=str(item.get("key", "")),
                    table=RuleTable.from_dict(item["table"]),
                    source=str(item.get("source", "")),
                    tests=[
                        pick(TestDraft, t)
                        for t in item.get("tests") or []
                        if isinstance(t, dict)
                    ],
                    status=str(item.get("status", "proposed")),
                )
            )
        return cls(
            requirements=[
                pick(RequirementDraft, r)
                for r in payload.get("requirements") or []
                if isinstance(r, dict)
            ],
            criteria=[
                pick(CriterionDraft, c)
                for c in payload.get("criteria") or []
                if isinstance(c, dict)
            ],
            tables=tables,
            sources=[str(s) for s in payload.get("sources") or []],
            generated_at=str(payload.get("generated_at", "")),
        )

    @property
    def pending(self) -> int:
        """Proposals nobody has decided on yet — what the card counts."""
        return sum(r.status == "proposed" for r in self.requirements) + sum(
            c.status == "proposed" for c in self.criteria
        )


# ---------------------------------------------------------------------------
# Reading the text
# ---------------------------------------------------------------------------

_PAGE_MARKER = re.compile(r"^\[page (\d+)\]$")
_BULLET = re.compile(r"^\s*(?:[-*•▪◦–—]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+")
_HEADING = re.compile(r"^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*\.?\s+)?(?P<title>[^.!?]{3,80})$")

_OBLIGATION = re.compile(
    r"\b(?:shall|must|should|has to|have to|needs? to|is required to|"
    r"are required to|will allow|will be able to|"
    r"doit|doivent|devra|devront|devrait|devraient|il faut|"
    r"est tenue?s? de|sont tenue?s? de|permettra|permettre|permet (?:à|a|aux|de)|"
    r"pourra|pourront|obligatoire|est requise?s?)\b",
    re.I,
)
#: A reference the document gives its own requirements.
_OWN_REF = re.compile(
    r"^\s*(?P<ref>(?:REQ|EF|ENF|EX|RG|RF|RNF|NFR|FR|BR|SR|US|UC)[-_ .]?\d{1,4}|"
    r"(?:Exigence|Requirement|Règle|Rule)\s+(?:n[°o]\s*)?\d{1,4})\s*[:.)\-–—]?\s*",
    re.I,
)
_NON_FUNCTIONAL_REF = re.compile(r"^(?:ENF|RNF|NFR)", re.I)
_NON_FUNCTIONAL = re.compile(
    r"\b(?:performance|perf|latenc|temps de réponse|response time|throughput|"
    r"débit|disponibilit|availability|uptime|sla\b|sécurit|security|chiffr|"
    r"encrypt|rgpd|gdpr|accessibilit|wcag|scalab|montée en charge|"
    r"compatib|navigateur|browser|ergonom|usability|maintenab|audit|"
    r"sauvegarde|backup|\d+\s?(?:ms|s|secondes?|seconds?)\b|\d+\s?%)",
    re.I,
)
_CRITERIA_HEADING = re.compile(
    r"acceptance criteria|critères? d[’']acceptation|conditions? de satisfaction|"
    r"definition of done|critères? de validation|critères? de recette",
    re.I,
)
_GHERKIN = re.compile(
    r"^\s*(?P<kw>given|when|then|and|but|étant donné(?: que)?|etant donne(?: que)?|"
    r"soit|quand|lorsque|alors|et|mais)\b\s*(?P<rest>.*)$",
    re.I,
)
_GHERKIN_THEN = re.compile(r"^(?:then|alors)$", re.I)
_SCENARIO = re.compile(r"^\s*(?:scenario|scénario|scenario outline)\s*:", re.I)
_SENTENCE_END = re.compile(r"(?<=[.!?;])\s+(?=[A-ZÀ-ÖØ-Þ(«\"])")


def _normalise(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", folded.lower()).strip()


def _key(prefix: str, text: str) -> str:
    digest = hashlib.sha1(_normalise(text).encode("utf-8"), usedforsecurity=False)
    return f"{prefix}-{digest.hexdigest()[:12]}"


def _readable(text: str) -> bool:
    """Words, not OCR noise: enough letters, and not a line of symbols."""
    letters = sum(ch.isalpha() for ch in text)
    return len(text) >= MIN_CHARS and letters >= 0.6 * len(text.replace(" ", ""))


def _clean_line(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(" -–—*•")


def _paragraphs(lines: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Lines joined into paragraphs: OCR and PDF text break sentences at the
    page's margin, not at the sentence's end. A bullet or a numbered item
    always starts a new one."""
    paragraphs: list[tuple[int, str]] = []
    current: list[str] = []
    page = 0
    for line_page, line in lines:
        stripped = line.strip()
        if not stripped:
            if current:
                paragraphs.append((page, " ".join(current)))
                current = []
            continue
        if (
            _BULLET.match(stripped)
            or _OWN_REF.match(stripped)
            or _GHERKIN.match(stripped)
        ):
            if current:
                paragraphs.append((page, " ".join(current)))
            current = [stripped]
            page = line_page
            continue
        if not current:
            page = line_page
        current.append(stripped)
    if current:
        paragraphs.append((page, " ".join(current)))
    return paragraphs


def _numbered_lines(text: str) -> list[tuple[int, str]]:
    """(page, line) with the `[page N]` markers consumed."""
    out: list[tuple[int, str]] = []
    page = 0
    for line in text.splitlines():
        if match := _PAGE_MARKER.match(line.strip()):
            page = int(match.group(1))
            out.append((page, ""))
            continue
        out.append((page, line))
    return out


def propose_requirements(text: str, source: str) -> list[RequirementDraft]:
    """Sentences that read as requirements, in document order. Ids come later."""
    found: list[RequirementDraft] = []
    seen: set[str] = set()
    for page, paragraph in _paragraphs(_numbered_lines(text)):
        body = _BULLET.sub("", paragraph, count=1)
        ref = ""
        if match := _OWN_REF.match(body):
            ref = re.sub(r"\s+", " ", match.group("ref")).strip()
            body = body[match.end() :]
        # The document's own reference names its first sentence; a sentence
        # after it in the same paragraph is a requirement only if it says so.
        for position, sentence in enumerate(_SENTENCE_END.split(body)):
            sentence = _clean_line(sentence)
            own = ref if position == 0 else ""
            if _GHERKIN.match(sentence) or not _readable(sentence):
                continue
            if not own and not _OBLIGATION.search(sentence):
                continue
            if len(sentence) > MAX_CHARS:
                sentence = sentence[:MAX_CHARS].rsplit(" ", 1)[0] + "…"
            key = _key("req", sentence)
            if key in seen:
                continue
            seen.add(key)
            non_functional = bool(_NON_FUNCTIONAL_REF.match(own)) or bool(
                _NON_FUNCTIONAL.search(sentence)
            )
            found.append(
                RequirementDraft(
                    key=key,
                    id="",
                    kind="NFR" if non_functional else "FR",
                    text=sentence,
                    source=source,
                    page=page,
                    ref=own,
                )
            )
            if len(found) >= MAX_REQUIREMENTS:
                return found
    return found


def propose_criteria(text: str, source: str) -> list[CriterionDraft]:
    """Given/When/Then scenarios and the bullets under an acceptance heading."""
    found: list[CriterionDraft] = []
    seen: set[str] = set()

    def add(page: int, criterion: str) -> None:
        criterion = _clean_line(criterion)
        if len(criterion) < MIN_CHARS or len(found) >= MAX_CRITERIA:
            return
        criterion = criterion[:MAX_CHARS]
        key = _key("ac", criterion)
        if key not in seen:
            seen.add(key)
            found.append(
                CriterionDraft(key=key, text=criterion, source=source, page=page)
            )

    lines = _numbered_lines(text)
    scenario: list[str] = []
    scenario_page = 0
    has_then = False
    under_heading = False
    for page, raw in lines:
        line = raw.strip()
        gherkin = _GHERKIN.match(line)
        if gherkin and (
            scenario or gherkin.group("kw").lower() not in ("et", "and", "mais", "but")
        ):
            if not scenario:
                scenario_page = page
            scenario.append(line)
            has_then = has_then or bool(_GHERKIN_THEN.match(gherkin.group("kw")))
            continue
        if scenario:
            if has_then:
                add(scenario_page, " ".join(scenario))
            scenario, has_then = [], False
        if _SCENARIO.match(line):
            continue
        if not line:
            continue
        if _CRITERIA_HEADING.search(line) and len(line) <= 80:
            under_heading = True
            continue
        if under_heading:
            if _BULLET.match(line):
                add(page, _BULLET.sub("", line, count=1))
                continue
            if _HEADING.match(line) and not line.endswith((".", ";", ",")):
                under_heading = False
    if scenario and has_then:
        add(scenario_page, " ".join(scenario))
    return found


# ---------------------------------------------------------------------------
# Ids
# ---------------------------------------------------------------------------

_ID = re.compile(r"\b(FR|NFR)-(\d+)\b", re.I)


def _highest_ids(*texts: str) -> dict[str, int]:
    highest = {"FR": 0, "NFR": 0}
    for text in texts:
        for match in _ID.finditer(text or ""):
            kind = match.group(1).upper()
            highest[kind] = max(highest[kind], int(match.group(2)))
    return highest


def _format_id(kind: str, number: int) -> str:
    return f"{kind}-{number:03d}"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _task_description(spec_dir: Path) -> str:
    try:
        payload = json.loads(_read(spec_dir / "requirements.json") or "{}")
    except ValueError:
        return ""
    value = payload.get("task_description") if isinstance(payload, dict) else ""
    return value if isinstance(value, str) else ""


def _number(drafts: list[RequirementDraft], taken: dict[str, int]) -> None:
    """Provisional ids for the undecided drafts, after everything already used."""
    counters = dict(taken)
    for draft in drafts:
        if draft.status == "accepted" and draft.id:
            continue
        if draft.status == "rejected":
            draft.id = ""
            continue
        counters[draft.kind] += 1
        draft.id = _format_id(draft.kind, counters[draft.kind])


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def drafts_path(spec_dir: Path) -> Path:
    return Path(spec_dir) / RESULT_DIR / DRAFTS_FILE


def load_drafts(spec_dir: Path) -> DraftSet | None:
    try:
        payload = json.loads(drafts_path(spec_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return DraftSet.from_dict(payload) if isinstance(payload, dict) else None


def save_drafts(spec_dir: Path, drafts: DraftSet) -> None:
    target = drafts_path(spec_dir)
    if not writable(target, spec_dir):
        logger.warning("docintel: refusing to write through a symlink: %s", target)
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(drafts.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError:
        logger.debug("docintel: could not persist %s", target, exc_info=True)


@dataclass
class SourceText:
    """One attachment's text, safe to read: masked, scanned, never an injection."""

    source: str
    text: str
    tables: list[RuleTable] = field(default_factory=list)


def _merge(previous: list, fresh: list) -> list:
    """Fresh proposals, with every decision already taken carried over.

    A decided item (accepted or rejected) survives even when its attachment is
    gone: forgetting a rejection is how it comes back on the next build.
    """
    decided = {item.key: item for item in previous if item.status != "proposed"}
    merged = [decided.pop(item.key, item) for item in fresh]
    return merged + list(decided.values())


def refresh(
    spec_dir: Path, sources: list[SourceText], project_dir: Path | None
) -> DraftSet | None:
    """Propose from `sources`, keep the decisions already taken, persist.

    Returns None — and writes nothing — when there is nothing to propose and
    nothing was ever decided: most tasks attach no specification.
    """
    spec_dir = Path(spec_dir)
    previous = load_drafts(spec_dir) or DraftSet()

    requirements: list[RequirementDraft] = []
    criteria: list[CriterionDraft] = []
    tables: list[TableDraft] = []
    languages: list[str] | None = None
    for item in sources:
        requirements += propose_requirements(item.text, item.source)
        criteria += propose_criteria(item.text, item.source)
        for table in item.tables:
            if languages is None:
                languages = project_languages(project_dir)
            tables.append(
                TableDraft(
                    key=_key("table", table.to_markdown()),
                    table=table,
                    source=item.source,
                    tests=drafts_for(table, languages, project_dir),
                )
            )

    drafts = DraftSet(
        requirements=_dedupe(_merge(previous.requirements, requirements)),
        criteria=_dedupe(_merge(previous.criteria, criteria)),
        tables=_dedupe(_merge(previous.tables, tables)),
        sources=[s.source for s in sources],
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    if not (drafts.requirements or drafts.criteria or drafts.tables):
        if drafts_path(spec_dir).is_file():
            try:
                drafts_path(spec_dir).unlink()
            except OSError:
                # A stale file that cannot be removed only keeps old proposals
                # on screen; the next reading that has any overwrites it.
                logger.debug("docintel: could not remove %s", drafts_path(spec_dir))
        return None
    _number(
        drafts.requirements,
        _highest_ids(_read(spec_dir / "spec.md"), _task_description(spec_dir)),
    )
    save_drafts(spec_dir, drafts)
    return drafts


def _dedupe(items: list) -> list:
    seen: set[str] = set()
    out = []
    for item in items:
        if item.key not in seen:
            seen.add(item.key)
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------


@dataclass
class Decision:
    """What `decide` wrote, for the card to finish the job."""

    #: Accepted requirements, with the ids they finally got.
    requirements: list[dict] = field(default_factory=list)
    #: Accepted criteria — the card adds them to the bullet editor.
    criteria: list[str] = field(default_factory=list)
    #: True when `spec.md` existed and now carries them.
    spec_updated: bool = False
    #: The Markdown to append to the task description when there is no
    #: `spec.md` yet: the spec writer reads the description and keeps the ids.
    description_section: str = ""
    #: Refreshed coverage summary, when `traceability.json` existed.
    traceability: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _edited(text: object) -> str:
    """One line of the person's text, masked the way an attachment is."""
    line = re.sub(r"\s+", " ", str(text or "")).strip().lstrip("#>").strip()
    line = line[:MAX_EDIT_CHARS]
    try:
        from .redact import redact_text

        line, _ = redact_text(line)
    except Exception:  # noqa: BLE001 - the person's own text, already on screen
        pass
    return line


def _source_note(draft: RequirementDraft) -> str:
    where = f"`{draft.source.rsplit('/', 1)[-1].replace('`', '_')}`"
    if draft.page:
        where += f", p. {draft.page}"
    if draft.ref:
        where += f", {draft.ref}"
    return f" _(from {where})_"


def _insert_section(spec_text: str, lines: list[str], criteria: list[str]) -> str:
    """Add to the attachments section, creating it after the requirements one."""
    block: list[str] = list(lines)
    if criteria:
        block += ["", f"### {CRITERIA_SUBTITLE}", ""]
        block += [f"- [ ] {c}" for c in criteria]
    body = spec_text.rstrip("\n").split("\n") if spec_text.strip() else []

    heading = f"## {SECTION_TITLE}"
    if heading in body:
        start = body.index(heading)
        end = next(
            (i for i in range(start + 1, len(body)) if body[i].startswith("## ")),
            len(body),
        )
        while end > start + 1 and not body[end - 1].strip():
            end -= 1
        body[end:end] = block
        return "\n".join(body) + "\n"

    section = ["", heading, "", *block, ""]
    anchor = next(
        (
            i
            for i, line in enumerate(body)
            if re.match(r"^##\s+.*(requirement|exigence)", line, re.I)
        ),
        None,
    )
    if anchor is None:
        return "\n".join(body + section).rstrip("\n") + "\n"
    end = next(
        (i for i in range(anchor + 1, len(body)) if body[i].startswith("## ")),
        len(body),
    )
    body[end:end] = section
    return "\n".join(body).rstrip("\n") + "\n"


def decide(
    spec_dir: Path,
    *,
    accept_requirements: dict[str, str] | None = None,
    reject_requirements: list[str] | None = None,
    accept_criteria: dict[str, str] | None = None,
    reject_criteria: list[str] | None = None,
    reject_tables: list[str] | None = None,
) -> Decision:
    """Apply what the person decided. The one writer of `spec.md` here.

    `accept_*` maps a draft's key to the text the person kept (their edit, or
    the proposal). Keys that name no draft are ignored: the card cannot add a
    requirement the document did not propose — that is what editing the spec
    is for.
    """
    spec_dir = Path(spec_dir)
    drafts = load_drafts(spec_dir)
    decision = Decision()
    if drafts is None:
        return decision
    accept_requirements = accept_requirements or {}
    accept_criteria = accept_criteria or {}

    spec_path = spec_dir / "spec.md"
    spec_text = _read(spec_path) if spec_path.is_file() else ""
    taken = _highest_ids(spec_text, _task_description(spec_dir))
    taken = {
        kind: max(
            taken[kind],
            *(
                int(d.id.split("-")[1])
                for d in drafts.requirements
                if d.status == "accepted" and d.kind == kind and d.id
            ),
            0,
        )
        for kind in taken
    }

    lines: list[str] = []
    for draft in drafts.requirements:
        if draft.status != "proposed":
            continue
        if draft.key in accept_requirements:
            text = _edited(accept_requirements[draft.key]) or draft.text
            taken[draft.kind] += 1
            draft.id = _format_id(draft.kind, taken[draft.kind])
            draft.text = text
            draft.status = "accepted"
            lines.append(f"- **{draft.id}**: {text}{_source_note(draft)}")
            decision.requirements.append(
                {"id": draft.id, "text": text, "key": draft.key}
            )
        elif draft.key in (reject_requirements or []):
            draft.status = "rejected"

    for criterion in drafts.criteria:
        if criterion.status != "proposed":
            continue
        if criterion.key in accept_criteria:
            criterion.text = _edited(accept_criteria[criterion.key]) or criterion.text
            criterion.status = "accepted"
            decision.criteria.append(criterion.text)
        elif criterion.key in (reject_criteria or []):
            criterion.status = "rejected"

    for table in drafts.tables:
        if table.key in (reject_tables or []):
            table.status = "rejected"

    if lines or decision.criteria:
        if spec_path.is_file() and writable(spec_path, spec_dir):
            try:
                spec_path.write_text(
                    _insert_section(spec_text, lines, decision.criteria),
                    encoding="utf-8",
                )
                decision.spec_updated = True
            except OSError:
                logger.warning("docintel: could not update %s", spec_path)
        if not decision.spec_updated and lines:
            decision.description_section = "\n".join(
                ["", "", f"## {SECTION_TITLE}", "", *lines, ""]
            )

    _number(drafts.requirements, taken)
    save_drafts(spec_dir, drafts)

    if decision.spec_updated and (spec_dir / "traceability.json").is_file():
        try:
            from spec.traceability import write_record

            decision.traceability = write_record(spec_dir)["coverage"]["summary"]
        except Exception:  # noqa: BLE001 - the record is refreshed next build
            logger.debug("docintel: traceability refresh failed", exc_info=True)
    return decision
