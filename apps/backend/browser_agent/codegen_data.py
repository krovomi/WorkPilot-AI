"""
The values typed while recording, as the generated test's data (#387).

What a person typed into a field (an email, a date, a number, a name…) is
the test's data, not its steps: the export takes it out of the code and the
test reads it by a key. Where it lives depends on the framework, in its own
idiom:

- Playwright, WebdriverIO, Selenium in Python, JavaScript, Ruby and C#: a
  JSON file next to the test (``<test>.data.json``), read by the test from its
  own folder (C#: the folder of its source, ``[CallerFilePath]``, else the
  build output);
- Cypress: a fixture (``cypress/fixtures/recorded/<test>.json``), read with
  ``cy.fixture``;
- Selenium in Java: the same file in the test resources of the test's package
  (``src/test/resources/e2e/<test>.data.json``), which Maven and Gradle put on
  the test classpath, read with ``getResourceAsStream`` and Selenium's own JSON
  reader (``org.openqa.selenium.json.Json``): no library or build rule added.

Every key and value enters the file only as a JSON literal
(``codegen_text.literal``). A key is made of ASCII words from the field's
label, placeholder, test id, name or id (``[a-z][a-z0-9_]*``, at most 40
characters), else from the value's kind; the same field typed twice with
the same value shares one key, any other repeat gets ``_2``, ``_3``…

Each value also gets a kind (:data:`DATA_KINDS`), by rules only, from its
shape and its field's words: the app shows it next to the key. No model sees
a typed value.

A secret is never data and its value is never written anywhere: the recorder
keeps no value for it, only the name of an environment variable
(``recording.ENV_NAME``). The data file holds that name, under a key that
ends in ``_env`` (``"password_env": "E2E_PASSWORD"``), and the test reads the
variable at run time. An empty value (a field cleared) stays a clear in the
code.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from .codegen_text import literal, py_literal, slug
from .recording import RecordedStep

DATA_KINDS = ("email", "date", "number", "phone", "url", "name", "text")
MAX_KEY = 40
#: Where Maven and Gradle keep a test's sources, and the resources beside them.
JAVA_SOURCES = "src/test/java/"
JAVA_RESOURCES = "src/test/resources/"
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


@dataclass(frozen=True)
class SecretRef:
    """A secret in the data: the key the test reads, and the variable it names."""

    key: str
    env: str


@dataclass
class TestData:
    """The typed values of an export, its secrets' variables, and each step's key."""

    values: list[DataValue] = field(default_factory=list)
    secrets: list[SecretRef] = field(default_factory=list)
    #: The key of each step whose value or variable moved to the data, by step id.
    keys: dict[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.values or self.secrets)


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


def _base_key(words: list[str], kind: str, limit: int = MAX_KEY) -> str:
    key = "_".join(words[:4])[:limit].strip("_")
    fallback = "value" if kind == "text" else kind
    if not key:
        return fallback
    if key[0].isdigit():
        key = f"{fallback}_{key}"[:limit].strip("_")
    return f"{key}_value" if key in _RESERVED else key


def _unique(base: str, used: set[str]) -> str:
    key, n = base, 1
    while key in used:
        n += 1
        key = f"{base[: MAX_KEY - len(str(n)) - 1]}_{n}"
    used.add(key)
    return key


def extract(steps: list[RecordedStep]) -> TestData:
    """The values typed into fields and the secrets' variables, keyed.

    A secret's value is never read: only its variable's name enters the data.
    An empty value is left out.
    """
    data = TestData()
    used: set[str] = set()
    typed: dict[str, str] = {}  # key -> value
    secrets: dict[str, str] = {}  # variable name -> key
    for step in steps:
        if step.secret_env and step.kind in ("fill", "select"):
            if step.secret_env not in secrets:
                words = _ascii_words(field_text(step))
                base = _base_key(words, "secret", MAX_KEY - len("_env")) + "_env"
                secrets[step.secret_env] = _unique(base, used)
                data.secrets.append(
                    SecretRef(secrets[step.secret_env], step.secret_env)
                )
            data.keys[step.id] = secrets[step.secret_env]
            continue
        if step.kind != "fill" or step.secret_env or not step.value:
            continue
        words = _ascii_words(field_text(step))
        kind = classify(step.value, words)
        base = _base_key(words, kind)
        if typed.get(base) == step.value:
            data.keys[step.id] = base
            continue
        key = _unique(base, used)
        typed[key] = step.value
        data.values.append(DataValue(key, kind, step.value))
        data.keys[step.id] = key
    return data


def json_file(data: TestData) -> str:
    """The data as a JSON object, each key and value a JSON literal.

    The typed values first, then each secret's variable name: never its value.
    """
    rows = [f"  {literal(v.key)}: {literal(v.value)}" for v in data.values]
    rows += [f"  {literal(r.key)}: {literal(r.env)}" for r in data.secrets]
    return "{\n" + ",\n".join(rows) + "\n}\n"


def file_name(name: str) -> str:
    """The data file of a test named ``name``, next to it."""
    return f"{slug(name, '-')}.data.json"


def cypress_fixture(name: str) -> str:
    """The fixture of a Cypress test named ``name``, as ``cy.fixture`` names it."""
    return f"recorded/{slug(name, '-')}.json"


def data_path(fmt: str, name: str, test_path: str) -> str:
    """Where the data file goes, relative to the project root."""
    if fmt == "cypress":
        return f"cypress/fixtures/{cypress_fixture(name)}"
    folder = test_path.rsplit("/", 1)[0]
    if fmt == "selenium-java" and folder.startswith(JAVA_SOURCES):
        # The test's package, in the resources Maven and Gradle put on the classpath.
        folder = JAVA_RESOURCES + folder[len(JAVA_SOURCES) :]
    return f"{folder}/{file_name(name)}"


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
