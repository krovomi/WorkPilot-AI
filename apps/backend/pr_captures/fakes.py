"""Fake personal data that looks like the real data it replaces.

A capture published in a pull request must not show a real person's e-mail,
phone number or IBAN, and a capture full of grey boxes no longer shows the
screen it was taken to prove. So each personal value is *replaced* by a fake of
the same kind and the same shape:

| Kind | Real | Fake |
|---|---|---|
| ``email`` | ``j.martin@acme.fr`` | ``camille.robert@exemple.fr`` (same top-level domain) |
| ``phone`` | ``+33 6 12 34 56 78`` | ``+33 6 47 90 13 52`` (country code, first digit, spacing kept) |
| ``iban`` | ``FR76 3000 …`` | ``FR02 4815 …`` (same country and grouping, valid check digits) |
| ``card`` | ``4970 1012 …`` | ``4111 1111 1111 1111`` (a test number of the same network) |
| ``name`` | ``Jeanne Martin`` | ``Camille Robert`` (same number of words) |
| ``address`` | ``3 rue Victor Hugo`` | ``12 rue des Lilas`` |
| anything else | ``sk-live-9f2…`` | ``ab-qxyz-4k7…`` (letters stay letters, digits stay digits) |

The choice is a keyed hash of the real value (HMAC-SHA256), with a key drawn
once per task and kept beside its captures: the same value gives the same fake
on every capture of the task, base branch and task alike, so a before/after
pair still compares; and without the key, nobody can tell which real value a
fake stands for. Nothing here stores a real value.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from pathlib import Path

__all__ = ["KEY_FILE", "Faker", "load_key"]

KEY_FILE = ".pseudonym-key"

_FIRST = (
    "Camille", "Alex", "Sam", "Charlie", "Dominique", "Claude", "Morgan",
    "Lou", "Jordan", "Robin", "Sacha", "Noa", "Eden", "Maxime", "Andrea",
)  # fmt: skip
_LAST = (
    "Robert", "Lambert", "Fontaine", "Garnier", "Chevalier", "Perrin",
    "Mercier", "Blanc", "Guerin", "Muller", "Faure", "Roussel", "Carpenter",
    "Hughes", "Walker",
)  # fmt: skip
_STREETS_FR = ("rue des Lilas", "avenue des Tilleuls", "allée des Cerisiers",
               "boulevard du Parc", "chemin des Vignes")  # fmt: skip
_STREETS_EN = ("Maple Street", "Oak Avenue", "Cedar Lane", "Park Road",
               "Elm Drive")  # fmt: skip
#: Published test numbers: valid for the Luhn check, never issued to anyone.
_TEST_CARDS = {
    "3": ("378282246310005", "371449635398431"),
    "4": ("4111111111111111", "4242424242424242", "4012888888881881"),
    "5": ("5555555555554444", "5105105105105100"),
    "6": ("6011111111111117", "6011000990139424"),
}
_FRENCH_TLDS = {"fr", "be", "ch", "lu", "ca", "re", "mc"}
_LETTERS = "abcdefghijklmnopqrstuvwxyz"


def load_key(directory: Path) -> bytes:
    """The task's key, drawn on first use and kept in ``directory``.

    Readable by its owner only. A key that cannot be kept is still drawn: the
    fakes of this run stay consistent with each other, only not with a later
    run's.
    """
    path = Path(directory) / KEY_FILE
    try:
        data = path.read_bytes()
        if len(data) >= 32 and not path.is_symlink():
            return data[:32]
    except OSError:
        pass
    key = secrets.token_bytes(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
    except OSError:
        pass
    return key


class _Stream:
    """Deterministic choices drawn from HMAC(key, kind:value)."""

    def __init__(self, key: bytes, kind: str, value: str) -> None:
        self._seed = hmac.new(key, f"{kind}:{value}".encode(), hashlib.sha256).digest()
        self._counter = 0
        self._buffer = b""

    def _byte(self) -> int:
        if not self._buffer:
            self._counter += 1
            self._buffer = hashlib.sha256(
                self._seed + self._counter.to_bytes(4, "big")
            ).digest()
        value, self._buffer = self._buffer[0], self._buffer[1:]
        return value

    def pick(self, options):
        return options[self._byte() % len(options)]

    def digit(self) -> str:
        return str(self._byte() % 10)

    def letter(self) -> str:
        return _LETTERS[self._byte() % 26]


def _shape(stream: _Stream, text: str) -> str:
    """Letters for letters (case kept), digits for digits, the rest as is."""
    out = []
    for char in text:
        if char.isdigit():
            out.append(stream.digit())
        elif char.isalpha() and char.isascii():
            letter = stream.letter()
            out.append(letter.upper() if char.isupper() else letter)
        else:
            out.append(char)
    return "".join(out)


def _iban_check(country: str, bban: str) -> str:
    rearranged = bban + country + "00"
    number = "".join(str(int(c, 36)) for c in rearranged.upper())
    return f"{98 - int(number) % 97:02d}"


class Faker:
    def __init__(self, key: bytes, *, french: bool = True) -> None:
        self._key = key
        self.french = french

    def _stream(self, kind: str, value: str) -> _Stream:
        return _Stream(self._key, kind, value.strip().lower())

    def name(self, value: str) -> str:
        stream = self._stream("name", value)
        words = len(value.split()) or 1
        if words == 1:
            return stream.pick(_FIRST)
        return f"{stream.pick(_FIRST)} {stream.pick(_LAST)}"

    def email(self, value: str) -> str:
        stream = self._stream("email", value)
        domain = value.rsplit("@", 1)[-1]
        tld = domain.rsplit(".", 1)[-1].lower() if "." in domain else "com"
        tld = tld if re.fullmatch(r"[a-z]{2,10}", tld) else "com"
        host = "exemple" if tld in _FRENCH_TLDS else "example"
        local = f"{stream.pick(_FIRST)}.{stream.pick(_LAST)}".lower()
        return f"{local}@{host}.{tld}"

    def phone(self, value: str) -> str:
        stream = self._stream("phone", value)
        match = re.match(r"\s*(\+\d{1,3}|00\d{1,3})", value)
        prefix = match.group(0) if match else ""
        rest = value[len(prefix) :]
        out: list[str] = []
        kept_first = False
        for char in rest:
            if char.isdigit():
                # The first digit says landline or mobile: kept, it is not personal.
                out.append(char if not kept_first else stream.digit())
                kept_first = True
            else:
                out.append(char)
        return prefix + "".join(out)

    def iban(self, value: str) -> str:
        stream = self._stream("iban", value)
        compact = re.sub(r"\s", "", value).upper()
        country, bban = compact[:2], compact[4:]
        fake_bban = _shape(stream, bban).upper()
        fake = country + _iban_check(country, fake_bban) + fake_bban
        # Same grouping as the real one.
        out, index = [], 0
        for char in value:
            if char.isspace():
                out.append(char)
            elif index < len(fake):
                out.append(fake[index])
                index += 1
        return "".join(out)

    def card(self, value: str) -> str:
        stream = self._stream("card", value)
        digits = re.sub(r"\D", "", value)
        candidates = [
            c for c in _TEST_CARDS.get(digits[:1], ()) if len(c) == len(digits)
        ] or [
            c for group in _TEST_CARDS.values() for c in group if len(c) == len(digits)
        ]
        if not candidates:
            return _shape(stream, value)
        fake = iter(stream.pick(candidates))
        return "".join(next(fake) if c.isdigit() else c for c in value)

    def address(self, value: str) -> str:
        stream = self._stream("address", value)
        street = stream.pick(_STREETS_FR if self.french else _STREETS_EN)
        number = 1 + stream._byte() % 98
        return f"{number} {street}"

    def other(self, value: str) -> str:
        return _shape(self._stream("other", value), value)

    def fake(self, kind: str, value: str) -> str:
        """A fake of ``kind`` for ``value``; an unknown kind keeps the shape."""
        maker = {
            "email": self.email,
            "phone": self.phone,
            "iban": self.iban,
            "card": self.card,
            "name": self.name,
            "address": self.address,
        }.get(kind, self.other)
        try:
            return maker(value)
        except (ValueError, IndexError, StopIteration):
            return self.other(value)
