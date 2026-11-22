"""
The values typed while recording, as the generated test's data (#387).

What a person typed into a field (an email, a date, a number, a name…) is
the test's data, not its steps: the export takes it out of the code and the
test reads it by a key. Where it lives depends on the framework, in its own
idiom:

- Playwright, WebdriverIO, Selenium in Python, JavaScript and Ruby: a JSON
  file next to the test (``<test>.data.json``), read by the test from its own
  folder;
- Cypress: a fixture (``cypress/fixtures/recorded/<test>.json``), read with
  ``cy.fixture``;
- Selenium in Java and C#: a ``TestData`` block of constants at the top of
  the test class, since neither reads JSON without a library or a build rule
  that copies the file next to the compiled test.

Every key and value enters the file or the block only through the target
language's literal (``codegen_text``); a JSON file is built from the JSON
literal of each key and value. A key is made of ASCII words from the field's
label, placeholder, test id, name or id (``[a-z][a-z0-9_]*``, at most 40
characters), else from the value's kind; the same field typed twice with
the same value shares one key, any other repeat gets ``_2``, ``_3``…

Each value also gets a kind (:data:`DATA_KINDS`), by rules only, from its
shape and its field's words: the app shows it next to the key. No model sees
a typed value. A secret never becomes data: its step carries the name of an
environment variable and no value (``recording.ENV_NAME``), and an empty
value (a field cleared) stays a clear in the code.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from .codegen_text import literal, py_literal, slug
from .recording import RecordedStep

DATA_KINDS = ("email", "date", "number", "phone", "url", "name", "text")
MAX_KEY = 40
#: Formats whose data is a block of constants in the test, not a file.
BLOCK_FORMATS = ("selenium-java", "selenium-csharp")
#: Keys a generated test already uses for the data itself.
_RESERVED = frozenset({"test_data"})

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_URL = re.compile(r"^https?://\S+$")
_DATE = re.compile(
    r"^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?"
    r"|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$"
)
_PHONE = re.compile(r"^\+?(?:[\s().-]*\d){6,20}[\s().-]*$")
_NUMBER = re.compile(r"^[+-]?\d+(?:[.,]\d+)?$")
#: A field's words that name what it holds, first match wins.
_FIELD_KINDS = (
    ("email", re.compile(r"\b(?:e ?mail|courriel)\b")),
    ("phone", re.compile(r"\b(?:phone|telephone|tel|mobile|cell)\b")),
    ("date", re.compile(r"\b(?:date|birthday|birth|dob|naissance|day|jour)\b")),
    ("url", re.compile(r"\b(?:url|website|homepage|site)\b")),
    (
        "name",
        re.compile(
            r"\b(?:name|nom|prenom|firstname|lastname|surname|fullname|username)\b"
        ),
    ),
    ("number", re.compile(r"\b(?:amount|quantity|qty|count|age|price|total)\b")),
)
#: A CSS selector's ``name`` attribute or id: words a key can come from.
_CSS_NAME = re.compile(r'\[name="((?:[^"\\]|\\.)+)"\]|#([A-Za-z][\w-]*)')
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


@dataclass(frozen=True)
class DataValue:
    """One typed value: the key the test reads it by, its kind and itself."""

    key: str
    kind: str
    value: str

    def to_dict(self) -> dict[str, str]:
        """What the app shows: the key and the kind, never the value."""
        return {"name": self.key, "kind": self.kind}


@dataclass
class TestData:
    """The typed values of an export, and the key each fill step reads."""

    values: list[DataValue] = field(default_factory=list)
    #: The key of each step whose value moved to the data, by step id.
    keys: dict[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.values)


def _ascii_words(text: str) -> list[str]:
    """``text`` as lowercase ASCII words, a camelCase name split into its words."""
    flat = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.findall(r"[a-z0-9]+", _CAMEL.sub(" ", flat).lower())


def field_text(step: RecordedStep) -> str:
    """What names the field: its label, placeholder, test id, accessible name or CSS name."""
    for strategy in ("label", "placeholder", "testid", "role", "css"):
        for s in step.selectors:
            if s.strategy != strategy:
                continue
            if strategy != "css":
                return s.value
            found = _CSS_NAME.search(s.value)
            if found:
                return found.group(1) or found.group(2)
    return ""


def classify(value: str, field_words: list[str]) -> str:
    """The kind of a typed value (:data:`DATA_KINDS`), by its shape and its field."""
    text = value.strip()
    said = " ".join(field_words)
    by_field = next((kind for kind, words in _FIELD_KINDS if words.search(said)), "")
    if _EMAIL.match(text):
        return "email"
    if _URL.match(text):
        return "url"
    if _DATE.match(text):
        return "date"
    if _PHONE.match(text) and (text[0] == "+" or by_field == "phone"):
        return "phone"
    if _NUMBER.match(text):
        return "phone" if by_field == "phone" else "number"
    return by_field or "text"


def _base_key(words: list[str], kind: str) -> str:
    key = "_".join(words[:4])[:MAX_KEY].strip("_")
    fallback = "value" if kind == "text" else kind
    if not key:
        return fallback
    if key[0].isdigit():
        key = f"{fallback}_{key}"[:MAX_KEY].strip("_")
    return f"{key}_value" if key in _RESERVED else key


def extract(steps: list[RecordedStep]) -> TestData:
    """The values typed into fields, keyed; a secret or an empty value is left out."""
    data = TestData()
    taken: dict[str, str] = {}  # key -> value
    flat: set[str] = set()  # keys without their underscores (C# names)
    for step in steps:
        if step.kind != "fill" or step.secret_env or not step.value:
            continue
        words = _ascii_words(field_text(step))
        kind = classify(step.value, words)
        base = _base_key(words, kind)
        if taken.get(base) == step.value:
            data.keys[step.id] = base
            continue
        key, n = base, 1
        while key in taken or key.replace("_", "") in flat:
            n += 1
            key = f"{base[: MAX_KEY - len(str(n)) - 1]}_{n}"
        taken[key] = step.value
        flat.add(key.replace("_", ""))
        data.values.append(DataValue(key, kind, step.value))
        data.keys[step.id] = key
    return data


def json_file(data: TestData) -> str:
    """The data as a JSON object, each key and value a JSON literal."""
    rows = [f"  {literal(v.key)}: {literal(v.value)}" for v in data.values]
    return "{\n" + ",\n".join(rows) + "\n}\n"


def file_name(name: str) -> str:
    """The data file of a test named ``name``, next to it."""
    return f"{slug(name, '-')}.data.json"


def cypress_fixture(name: str) -> str:
    """The fixture of a Cypress test named ``name``, as ``cy.fixture`` names it."""
    return f"recorded/{slug(name, '-')}.json"


def data_path(fmt: str, name: str, test_path: str) -> str | None:
    """Where the data file goes, relative to the project; None for a block of constants."""
    if fmt in BLOCK_FORMATS:
        return None
    if fmt == "cypress":
        return f"cypress/fixtures/{cypress_fixture(name)}"
    folder = test_path.rsplit("/", 1)[0]
    return f"{folder}/{file_name(name)}"


def constant_name(key: str) -> str:
    """A key as a Java constant: ``birth_date`` → ``BIRTH_DATE``."""
    return key.upper()


def pascal_name(key: str) -> str:
    """A key as a C# constant: ``birth_date`` → ``BirthDate``."""
    return "".join(part[:1].upper() + part[1:] for part in key.split("_"))


def py_data_lines(name: str, data: TestData) -> list[str]:
    """The module constant a Python test reads its typed values from."""
    if not data:
        return []
    return [
        f"#: The values typed while recording, from {file_name(name)} next to this file.",
        "TEST_DATA = json.loads(",
        f"    Path(__file__).with_name({py_literal(file_name(name))})"
        '.read_text(encoding="utf-8")',
        ")",
        "",
        "",
    ]
