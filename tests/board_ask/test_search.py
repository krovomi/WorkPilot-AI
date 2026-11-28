"""The keyword search of a server board question: any language, no dictionary."""

from __future__ import annotations

from board_ask.search import (
    Document,
    Field,
    KeywordIndex,
    detect_languages,
    fold,
    tokenize,
)


def test_words_are_folded_stemmed_and_common_words_dropped():
    assert fold("Révisée") == "revisee"
    assert tokenize("La page d'administration des Pages") == ["page", "admini", "page"]
    # Scripts without spaces are read as pairs of characters; one character stays.
    assert tokenize("管理页面") == ["管理", "理页", "页面"]
    assert tokenize("页") == ["页"]


def test_languages_are_told_from_their_common_words():
    texts = [
        "La page de connexion est revue pour les administrateurs",
        "Le tableau de bord des ventes",
        "The admin page is now in the settings",
        "x",
    ]
    assert detect_languages(texts) == ["fr", "en"]
    # A language one text in ten does not reach is left out.
    assert detect_languages(
        ["the page is in the menu"] * 11 + ["la page de la vente"]
    ) == ["en"]
    assert detect_languages(["nothing here"]) == []


def _index() -> KeywordIndex:
    return KeywordIndex(
        [
            Document("t1", (Field("Administration des utilisateurs", 3),)),
            Document("t2", (Field("Login page", 3), Field("admin settings", 1))),
            Document("t3", (Field("管理页面", 1),)),
            Document("t4", (Field("Payments", 1), Field("", 1))),
        ]
    )


def test_a_short_word_finds_the_longer_ones_it_begins():
    index = _index()
    assert len(index) == 4
    assert set(index.search([("admin", 1.0)], 10)) == {"t1", "t2"}
    # A long query word meets a short indexed one it begins with.
    assert index.search([("adminis", 1.0)], 10)[0] in {"t1", "t2"}
    assert "t2" in index.search([("administrator", 1.0)], 10)
    assert index.search([("管理", 1.0)], 10) == ["t3"]
    assert index.search([("页", 1.0)], 10) == []


def test_a_query_is_weighted_and_limited():
    index = _index()
    assert index.search([("payments", 0.0)], 10) == []
    assert index.search([("payments", 1.0), ("login", 0.5)], 1) == ["t4"]
    assert index.search([("login", 1.0)], -1) == []
    assert KeywordIndex([]).search([("admin", 1.0)], 5) == []
