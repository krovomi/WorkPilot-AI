"""Fakes that look like the real data they replace, and give nothing of it away."""

from __future__ import annotations

import re
import stat

import pytest
from foundation.platform import is_windows
from pr_captures.fakes import _STREETS_EN, _STREETS_FR, KEY_FILE, Faker, load_key
from pr_captures.privacy import _luhn

KEY = b"k" * 32


def _iban_valid(value: str) -> bool:
    compact = re.sub(r"\s", "", value).upper()
    rearranged = compact[4:] + compact[:4]
    return int("".join(str(int(c, 36)) for c in rearranged)) % 97 == 1


def test_the_same_value_gives_the_same_fake_and_another_key_another():
    one, again, other = Faker(KEY), Faker(KEY), Faker(b"z" * 32)
    value = "jeanne.martin@acme.fr"
    assert one.email(value) == again.email(value)
    assert one.email(value) != value
    assert any(
        Faker(KEY).fake(kind, v) != other.fake(kind, v)
        for kind, v in (("email", value), ("phone", "+33 6 12 34 56 78"))
    )


def test_an_email_keeps_its_top_level_domain():
    faker = Faker(KEY)
    fake = faker.email("jeanne.martin@acme.fr")
    assert re.fullmatch(r"[a-z]+\.[a-z]+@exemple\.fr", fake)
    assert faker.email("bob@corp.io").endswith("@example.io")
    assert faker.email("weird@localhost").endswith("@example.com")


@pytest.mark.parametrize(
    "real",
    ["+33 6 12 34 56 78", "06 12 34 56 78", "0044 20 7946 0958", "(415) 555-0134"],
)
def test_a_phone_keeps_its_prefix_first_digit_and_layout(real):
    fake = Faker(KEY).phone(real)
    assert len(fake) == len(real)
    assert re.sub(r"\d", "9", fake) == re.sub(r"\d", "9", real)
    prefix = re.match(r"(\+\d{1,3}|00\d{1,3})", real)
    start = prefix.group(0) if prefix else ""
    assert fake.startswith(start)
    rest_real = real[len(start) :]
    rest_fake = fake[len(start) :]
    assert re.search(r"\d", rest_fake).group(0) == re.search(r"\d", rest_real).group(0)
    assert fake != real


def test_an_iban_keeps_country_and_grouping_with_valid_check_digits():
    real = "FR76 3000 6000 0112 3456 7890 189"
    fake = Faker(KEY).iban(real)
    assert fake[:2] == "FR"
    assert [len(g) for g in fake.split(" ")] == [len(g) for g in real.split(" ")]
    assert _iban_valid(fake)
    assert fake != real


def test_a_card_becomes_a_test_number_of_the_same_network():
    real = "4970 1012 3456 7899"
    fake = Faker(KEY).card(real)
    assert fake.replace(" ", "") in {
        "4111111111111111",
        "4242424242424242",
        "4012888888881881",
    }
    assert [len(g) for g in fake.split(" ")] == [4, 4, 4, 4]
    assert _luhn(fake.replace(" ", ""))
    amex = Faker(KEY).card("3714-496353-98431")
    assert amex.count("-") == 2 and amex[0] == "3"


def test_names_addresses_and_the_rest():
    faker = Faker(KEY)
    assert len(faker.name("Jeanne Martin").split()) == 2
    assert len(faker.name("Jeanne").split()) == 1
    french = Faker(KEY, french=True).address("3 rue Victor Hugo")
    english = Faker(KEY, french=False).address("3 Baker Street")
    assert re.fullmatch(r"\d{1,2} .+", french)
    assert any(street in french for street in _STREETS_FR)
    assert any(street in english for street in _STREETS_EN)
    shaped = faker.other("sk-LIVE-9f2a")
    assert re.fullmatch(r"[a-z]{2}-[A-Z]{4}-\d[a-z]\d[a-z]", shaped)
    assert faker.fake("unknown-kind", "ab12") == faker.other("ab12")


def test_the_key_is_drawn_once_and_kept_for_its_owner(tmp_path):
    key = load_key(tmp_path)
    assert len(key) == 32
    assert load_key(tmp_path) == key
    if not is_windows():
        mode = stat.S_IMODE((tmp_path / KEY_FILE).stat().st_mode)
        assert mode == 0o600


def test_a_key_that_cannot_be_kept_is_still_drawn(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    assert len(load_key(blocker / "inside")) == 32
