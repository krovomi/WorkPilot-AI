"""Personal data on a capture: replaced by fakes of the same kind, never sent.

A capture of an app running on a development database shows whatever that
database holds: a customer's e-mail in a table, a phone number in a form, an
IBAN on an invoice. Once it is in a pull request it is in every clone and every
notification of the forge. So each personal value is replaced, before the
image leaves the machine, by a fake of the same kind and shape (`fakes.py`):
the screen still reads like the real one, and nobody's data is in it.

Two passes, and the result says which ones ran:

- **in the page** (web and Electron, while the screen is open): the verifier's
  screenshot collects the values of the fields a browser knows are personal
  (e-mail, phone, name, address, card, by type and `autocomplete`), of the
  elements a team marks (`[data-private]`, `[data-pii]`, `[data-sensitive]`,
  its own selectors), and every text that looks like an e-mail, a phone
  number, an IBAN or a card number; it swaps them for their fakes, takes the
  screenshot, and puts the page back as it was, so the rest of the scenario
  runs on the real page. The capture on disk never held the real values.
- **on the image, by OCR on the machine** (every platform: a Windows window, a
  phone frame, a WinDev screen, and the web again for text drawn on a canvas):
  each recognised word that is part of personal data or of a secret
  (`docintel.redact`, the pre-commit table) is painted over with its
  background and the fake is written in its place. Only local engines are
  asked: a screenshot is not sent to a cloud OCR to find out whether it may be
  sent somewhere.

When a fake cannot be drawn (no font), the words are covered with an opaque
block instead, never blurred: a blurred line of text can be read back. The
published copy is always re-encoded from pixels, so no metadata of the
original (PNG text chunks, EXIF) reaches it.

A name in free text is not personal data any pattern can recognise; a team
marks such places with `data-private` or its own selectors. A capture no pass
could check is ``unchecked``; `publication` keeps it on the task unless the
team said otherwise (`CAPTURES_PUBLISH_UNCHECKED`).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from .fakes import Faker

__all__ = [
    "DEFAULT_FIELDS",
    "PageCheck",
    "ProtectResult",
    "apply_script",
    "collect_script",
    "find_spans",
    "local_ocr_env",
    "page_mapping",
    "protect_capture",
    "read_page_check",
    "restore_script",
    "write_page_check",
]

logger = logging.getLogger(__name__)

#: (selector, kind) for the elements a browser, or a team, already calls
#: personal. A password is drawn as dots: nothing to replace.
DEFAULT_FIELDS: tuple[tuple[str, str], ...] = (
    ("input[type=email]", "email"),
    ("input[type=tel]", "phone"),
    ("[autocomplete*=email i]", "email"),
    ("[autocomplete*=tel i]", "phone"),
    ("[autocomplete*=name i]:not([autocomplete=username i])", "name"),
    ("[autocomplete*=address i]", "address"),
    ("[autocomplete*=postal i]", "other"),
    ("[autocomplete*=cc-number i]", "card"),
    ("[autocomplete*=bday i]", "other"),
    ("input[name*=email i]", "email"),
    ("input[name*=phone i]", "phone"),
    ("input[name*=iban i]", "iban"),
    ("[data-private]", "auto"),
    ("[data-pii]", "auto"),
    ("[data-sensitive]", "auto"),
)

#: Values past this many are a page that is mostly personal data: the capture
#: is withheld rather than published.
MAX_VALUES = 200
MAX_VALUE_CHARS = 200
SIDECAR_SUFFIX = ".privacy.json"
_SENTINEL = "WPPAGE"

# What looks like personal data in a line of text. Deliberately broad: a fake
# in the wrong place costs a word of context, a miss costs a person's data.
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<![\w+])(?:\+|00)?\d[\d .()-]{7,}\d(?!\w)")
#: An ISO date with a time is digits and separators too, and not a phone.
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b")
_CARD = re.compile(
    r"(?<![\d-])(?:\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}"
    r"|\d{4}[ -]?\d{6}[ -]?\d{4,5}|\d{13,19})(?![\d-])"
)

#: The same shapes, for the page's own text nodes (JavaScript syntax).
_PAGE_PATTERNS = (
    r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",
    r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b",
    r"(?:\+|00)?\d[\d .()-]{7,}\d",
)


def _luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        number = int(char)
        if index % 2 == 1:
            number *= 2
            if number > 9:
                number -= 9
        total += number
    return total % 10 == 0


def _is_phone(text: str) -> bool:
    return len(re.sub(r"\D", "", text)) >= 9 and not _DATE.search(text)


def find_spans(line: str) -> list[tuple[int, int, str]]:
    """(start, end, kind) of every personal value in ``line``, without overlaps."""
    spans: list[tuple[int, int, str]] = []

    def free(start: int, end: int) -> bool:
        return all(end <= s or start >= e for s, e, _ in spans)

    for match in _EMAIL.finditer(line):
        spans.append((match.start(), match.end(), "email"))
    for match in _IBAN.finditer(line):
        if free(match.start(), match.end()):
            spans.append((match.start(), match.end(), "iban"))
    for match in _CARD.finditer(line):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits) and free(*match.span()):
            spans.append((match.start(), match.end(), "card"))
    for match in _PHONE.finditer(line):
        if _is_phone(match.group(0)) and free(*match.span()):
            spans.append((match.start(), match.end(), "phone"))
    return sorted(spans)


def _kind_of(value: str) -> str:
    spans = find_spans(value)
    if len(spans) == 1 and spans[0][1] - spans[0][0] >= len(value.strip()) - 1:
        return spans[0][2]
    return "other"


# -- the page ------------------------------------------------------------------


def collect_script(extra_selectors: Iterable[str] = ()) -> str:
    """A function for `BrowserSession.evaluate`: the personal values on screen.

    The team's selectors arrive as a JSON array literal — data, never script —
    and each one is tried on its own, so a selector the browser refuses only
    drops itself. The answer is base64 JSON between two sentinels, so no
    quoting of the transport (MCP text, a Python repr) can cut it.
    """
    fields = [list(f) for f in DEFAULT_FIELDS] + [
        [s, "auto"] for s in extra_selectors if s
    ]
    return (
        "() => {"
        f"const fields = {json.dumps(fields)};"
        f"const pats = {json.dumps(list(_PAGE_PATTERNS))}.map(p => new RegExp(p, 'g'));"
        "const out = {lang: document.documentElement.lang || '', fields: [], texts: []};"
        "const keep = (list, item) => { if (list.length < 400) list.push(item); };"
        "for (const [sel, kind] of fields) { let found = [];"
        " try { found = document.querySelectorAll(sel); } catch (e) { continue; }"
        " for (const el of found) {"
        "  if ('value' in el && el.tagName !== 'BUTTON') {"
        "   if (el.type === 'password' || !el.value) continue;"
        "   keep(out.fields, [kind, String(el.value)]); continue; }"
        "  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;"
        "  while ((n = walk.nextNode())) { const t = (n.nodeValue || '').trim();"
        "   if (t) keep(out.fields, [kind, t]); } } }"
        "if (document.body) {"
        " const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);"
        " let node; let seen = 0;"
        " while ((node = walk.nextNode()) && seen < 5000) { seen++;"
        "  const text = node.nodeValue || ''; if (text.length < 6) continue;"
        "  for (const re of pats) { re.lastIndex = 0; let m;"
        "   while ((m = re.exec(text)) !== null) {"
        "    if (m[0].length === 0) { re.lastIndex++; continue; }"
        "    keep(out.texts, m[0]); } } } }"
        "const json = JSON.stringify(out);"
        "const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));"
        f"return '{_SENTINEL}:' + b64 + ':{_SENTINEL}';"
        "}"
    )


_ANSWER = re.compile(rf"{_SENTINEL}:([A-Za-z0-9+/=]*):{_SENTINEL}")


def _decode(answer: str) -> dict | None:
    match = _ANSWER.search(answer or "")
    if not match:
        return None
    try:
        data = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def page_mapping(answer: str, key: bytes) -> tuple[dict[str, str], list[str]] | None:
    """(real -> fake, kinds) from the collect script's answer, or None.

    None is "the page could not be read" (an MCP error, a page that closed):
    the capture then counts on OCR alone, never on an empty mapping.
    """
    data = _decode(answer)
    if data is None:
        return None
    faker = Faker(key, french=str(data.get("lang") or "").lower().startswith("fr"))
    mapping: dict[str, str] = {}
    kinds: list[str] = []

    def add(kind: str, value: object) -> None:
        if not isinstance(value, str):
            return
        value = value.strip()
        if not value or len(value) > MAX_VALUE_CHARS or value in mapping:
            return
        if kind == "auto":
            kind = _kind_of(value)
        if kind == "card" and not _luhn(re.sub(r"\D", "", value)):
            return
        if kind == "phone" and not _is_phone(value):
            return
        mapping[value] = faker.fake(kind, value)
        kinds.append(kind)

    for item in (data.get("fields") or [])[: MAX_VALUES * 2]:
        if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str):
            add(item[0], item[1])
    for text in (data.get("texts") or [])[: MAX_VALUES * 2]:
        # A text node's match is only personal when Python reads it so too
        # (a date has the phone's characters, not its digits).
        if isinstance(text, str) and (kind := _kind_of(text)) != "other":
            add(kind, text)
    return mapping, sorted(set(kinds))


def apply_script(mapping: dict[str, str]) -> str:
    """Swap every real value on the page for its fake; keep what to put back.

    The mapping is a JSON literal (data). Longer values first, so a phone
    number inside an address is not swapped before the address.
    """
    pairs = sorted(mapping.items(), key=lambda kv: -len(kv[0]))
    return (
        "() => {"
        f"const pairs = {json.dumps(pairs, ensure_ascii=False)};"
        "const undo = []; let count = 0;"
        "const swap = (text) => { let out = text;"
        " for (const [real, fake] of pairs) { if (out.includes(real)) {"
        "  out = out.split(real).join(fake); count++; } } return out; };"
        "for (const el of document.querySelectorAll('input, textarea')) {"
        " if (el.type === 'password' || !el.value) continue;"
        " const next = swap(el.value);"
        " if (next !== el.value) { undo.push([el, 'value', el.value]); el.value = next; } }"
        "if (document.body) {"
        " const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);"
        " let node; while ((node = walk.nextNode())) {"
        "  const next = swap(node.nodeValue || '');"
        "  if (next !== node.nodeValue) { undo.push([node, 'nodeValue', node.nodeValue]);"
        "   node.nodeValue = next; } } }"
        "window.__workpilotPseudonyms = undo;"
        "return 'replaced=' + count;"
        "}"
    )


def restore_script() -> str:
    """Put back what `apply_script` swapped, so the scenario goes on on real data."""
    return (
        "() => { const undo = window.__workpilotPseudonyms || [];"
        " for (const [target, prop, value] of undo.reverse()) { target[prop] = value; }"
        " window.__workpilotPseudonyms = []; return 'restored=' + undo.length; }"
    )


@dataclass
class PageCheck:
    replaced: int = 0
    kinds: list[str] = field(default_factory=list)
    #: The fakes now on the page: the OCR pass leaves them as they are. A fake
    #: is not personal data, so keeping it costs nothing.
    fakes: list[str] = field(default_factory=list)


def write_page_check(image: Path, check: PageCheck) -> bool:
    """Say, beside the capture, that its page was pseudonymised before it was taken."""
    try:
        image.with_name(image.name + SIDECAR_SUFFIX).write_text(
            json.dumps(
                {
                    "page": {
                        "replaced": check.replaced,
                        "kinds": check.kinds,
                        "fakes": check.fakes[:MAX_VALUES],
                    }
                }
            ),
            encoding="utf-8",
        )
    except OSError:
        return False
    return True


def read_page_check(image: Path) -> PageCheck | None:
    try:
        data = json.loads(
            image.with_name(image.name + SIDECAR_SUFFIX).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    page = data.get("page") if isinstance(data, dict) else None
    if not isinstance(page, dict) or not isinstance(page.get("replaced"), int):
        return None
    kinds = [k for k in page.get("kinds") or [] if isinstance(k, str)][:20]
    fakes = [f for f in page.get("fakes") or [] if isinstance(f, str)][:MAX_VALUES]
    return PageCheck(max(0, page["replaced"]), kinds, fakes)


# -- the image -----------------------------------------------------------------


@dataclass
class ProtectResult:
    #: ``pseudonymized`` (fakes in place of real data), ``clean`` (checked,
    #: nothing personal), ``unchecked`` (no pass could run), ``withheld`` (too
    #: much personal data, or a check failed closed), ``failed`` (no copy).
    status: str
    replaced: int = 0
    #: The passes that ran: ``page``, ``ocr:<engine>``.
    checks: list[str] = field(default_factory=list)
    #: The kinds found (``email``, ``phone``, ``iban``, ``card``, ``name``…,
    #: or a secret's pattern name), never a value.
    kinds: list[str] = field(default_factory=list)
    #: Why a pass did not run: ``ocr:not-installed``, ``ocr:disabled``…
    notes: list[str] = field(default_factory=list)

    @property
    def checked(self) -> bool:
        return self.status in ("pseudonymized", "clean")

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "replaced": self.replaced,
            "checks": list(self.checks),
            "kinds": sorted(set(self.kinds)),
            "notes": list(self.notes),
        }


def local_ocr_env(env: dict[str, str]) -> dict[str, str]:
    """``env`` with the OCR chain cut down to the engines that stay on the machine."""
    from docintel.engines import ENGINES
    from docintel.settings import OCR_ENGINE_ENV, ocr_engines

    local = [n for n in ocr_engines(env) if n in ENGINES and ENGINES[n].local]
    return {**env, OCR_ENGINE_ENV: ",".join(local or ["tesseract"])}


@dataclass(frozen=True)
class _Patch:
    left: int
    top: int
    width: int
    height: int
    text: str


def _line_spans(line: str) -> list[tuple[int, int, str]]:
    from docintel.redact import find_secrets

    spans = find_spans(line)
    for secret in find_secrets(line):
        if all(secret.end <= s or secret.start >= e for s, e, _ in spans):
            spans.append((secret.start, secret.end, secret.kind))
    return spans


def _patches(
    outcome, faker: Faker, keep: frozenset[str] = frozenset()
) -> tuple[list[_Patch], list[str]] | None:
    """The words to repaint and their fakes; None when a value has no place."""
    lines = outcome.text.splitlines()
    patches: list[_Patch] = []
    kinds: list[str] = []
    for index, line in enumerate(lines):
        spans = [s for s in _line_spans(line) if line[s[0] : s[1]] not in keep]
        if not spans:
            continue
        words = [b for b in outcome.boxes if b.line == index and b.width > 0]
        # Where each word sits in the line's text, left to right.
        placed: list[tuple[int, int, object]] = []
        cursor = 0
        for box in words:
            at = line.find(box.text, cursor) if box.text else -1
            if at < 0:
                continue
            placed.append((at, at + len(box.text), box))
            cursor = at + len(box.text)
        for start, end, kind in spans:
            covered = [b for s, e, b in placed if s < end and e > start]
            if not covered:
                return None
            left = min(b.left for b in covered)
            top = min(b.top for b in covered)
            right = max(b.left + b.width for b in covered)
            bottom = max(b.top + b.height for b in covered)
            first = min(s for s, e, b in placed if b in covered)
            last = max(e for s, e, b in placed if b in covered)
            text = line[first:last]
            fake = (
                line[first:start] + faker.fake(kind, line[start:end]) + line[end:last]
            )
            patches.append(
                _Patch(left, top, right - left, bottom - top, fake if text else "")
            )
            kinds.append(kind)
    return patches, kinds


def _colours(
    picture, patch: _Patch
) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """(background, ink): the commonest colour around the words, and the one inside
    them farthest from it."""
    width, height = picture.size
    left, top = max(0, patch.left - 2), max(0, patch.top - 2)
    right = min(width - 1, patch.left + patch.width + 2)
    bottom = min(height - 1, patch.top + patch.height + 2)
    border: dict[tuple[int, int, int], int] = {}
    for x in range(left, right + 1):
        for y in (top, bottom):
            colour = picture.getpixel((x, y))
            border[colour] = border.get(colour, 0) + 1
    for y in range(top, bottom + 1):
        for x in (left, right):
            colour = picture.getpixel((x, y))
            border[colour] = border.get(colour, 0) + 1
    background = max(border, key=lambda c: border[c]) if border else (255, 255, 255)
    ink = (0, 0, 0) if sum(background) > 382 else (255, 255, 255)
    best = -1
    for x in range(patch.left, min(width, patch.left + patch.width), 2):
        for y in range(patch.top, min(height, patch.top + patch.height), 2):
            colour = picture.getpixel((x, y))
            distance = sum(abs(a - b) for a, b in zip(colour, background, strict=True))
            if distance > best:
                best, ink = distance, colour
    return background, ink


def _font(size: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # an older Pillow: one bitmap size only
        return ImageFont.load_default()


def _repaint(picture, patches: list[_Patch]) -> None:
    from PIL import ImageDraw

    draw = ImageDraw.Draw(picture)
    width, height = picture.size
    for patch in patches:
        background, ink = _colours(picture, patch)
        box = (
            max(0, patch.left - 2),
            max(0, patch.top - 2),
            min(width, patch.left + patch.width + 2),
            min(height, patch.top + patch.height + 2),
        )
        draw.rectangle(box, fill=background)
        if not patch.text:
            draw.rectangle(box, fill=(88, 94, 106))
            continue
        size = max(8, int(patch.height * 0.95))
        font = _font(size)
        while size > 8 and draw.textlength(patch.text, font=font) > patch.width * 1.2:
            size -= 1
            font = _font(size)
        draw.text((patch.left, patch.top), patch.text, fill=ink, font=font)


def _save(picture, target: Path) -> bool:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f".{target.name}.partial")
        picture.save(partial, format="PNG")
        partial.replace(target)
    except OSError:
        return False
    return True


def protect_capture(
    image: Path,
    target: Path,
    *,
    key: bytes,
    env: dict[str, str],
    policy_paths: tuple[Path, ...] = (),
    enabled: bool = True,
) -> ProtectResult:
    """Write the publishable copy of ``image`` to ``target``. Never raises.

    With the protection turned off by the team, the copy is the image
    re-encoded (metadata dropped) and the result is ``clean`` with no check.
    """
    try:
        from PIL import Image

        with Image.open(image) as source:
            source.load()
            picture = source.convert("RGB")
    except Exception:  # noqa: BLE001 - an unreadable capture is not published
        return ProtectResult("failed", notes=["image:unreadable"])

    if not enabled:
        ok = _save(picture, target)
        return ProtectResult("clean" if ok else "failed", notes=["protect:off"])

    result = ProtectResult("unchecked")
    page = read_page_check(image)
    if page is not None:
        result.checks.append("page")
        result.replaced += page.replaced
        result.kinds += page.kinds

    try:
        from docintel.ocr import ocr_image

        outcome = ocr_image(image, local_ocr_env(env), policy_paths=policy_paths)
        if outcome.text:
            keep = frozenset(page.fakes) if page is not None else frozenset()
            found = _patches(outcome, Faker(key), keep)
            if found is None:
                result.status = "withheld"
                result.notes.append("ocr:no-boxes")
                return result
            patches, kinds = found
            if len(patches) > MAX_VALUES:
                result.status = "withheld"
                result.notes.append("too-much-personal-data")
                return result
            _repaint(picture, patches)
            result.replaced += len(patches)
            result.kinds += kinds
            result.checks.append(f"ocr:{outcome.engine or 'local'}")
        elif outcome.reason == "empty":
            result.checks.append(f"ocr:{outcome.engine or 'local'}")
        else:
            result.notes.append(f"ocr:{outcome.reason or 'failed'}")
    except Exception as exc:  # noqa: BLE001 - a check that breaks fails closed
        logger.debug("pr_captures: OCR pass failed: %s", exc)
        result.status = "withheld"
        result.notes.append("ocr:failed")
        return result

    if not result.checks:
        return result
    if not _save(picture, target):
        result.status = "failed"
        return result
    result.status = "pseudonymized" if result.replaced else "clean"
    return result
