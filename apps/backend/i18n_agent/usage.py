"""Which translation keys the code uses, on every stack (#346).

A key is *orphan* when no source file names it. The calls that name a key:

- i18next / react-i18next / next-intl / vue-i18n / svelte-i18n: ``t("a.b")``,
  ``$t('a.b')``, ``i18n.t``, ``<Trans i18nKey="a.b">``, ``t("ns:a.b")``, and
  ``useTranslation("ns")`` / ``useTranslations("ns")`` which put ``t("b")``
  under ``ns``;
- Angular: ``'a.b' | translate``, ``translate.instant('a.b')``, ``marker('a.b')``;
- .NET: ``Localizer["Key"]``, ``Resources.Key``, ``Strings.Key``;
- Android ``R.string.key`` / ``@string/key``, iOS ``NSLocalizedString("key"``,
  ``String(localized: "key"``, SwiftUI ``Text("key")``;
- Flutter ``AppLocalizations.of(context)!.key``, ``l10n.key``, ``S.of(context).key``;
- gettext ``_("…")``, ``gettext``, ``ngettext``; Laravel ``__('a.b')``,
  ``trans``, ``@lang``; Rails ``t('.a')``, ``I18n.t``; Java ``getString("key")``.

A key built at run time (``t(`rules.${id}.title`)``, ``t("errors." + code)``)
cannot be found by name: its static prefix marks every key under it as used.
A call whose key is a bare variable (``t(label)``) could name any key, so in a
project that has one, an orphan is only *possibly* unused and says so.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

__all__ = ["KeyUsage", "collect_usage"]

_Q = r"""["'`]"""
_KEY = r"""([\w$][\w.:\-/$]*)"""
_STATIC_CALLS = re.compile(
    # Bare functions (``t``, ``_``, ``__``) must not be a method of something else;
    # the qualified ones (``this.translate.instant``, ``I18n.t``) may be.
    r"(?:(?:(?<![\w.$])(?:\$?t|__|_|trans|trans_choice|@lang|getString|NSLocalizedString|marker|"
    r"gettext|ngettext|pgettext|LocalizedStringKey)|"
    r"(?<![\w$])(?:\$?i18n\.t|I18n\.t|i18n\.translate|translate\.instant|translate\.get))\s*\(|"
    r"(?<![\w.$])String\(\s*localized:|(?<![\w$])(?:intl\.)?formatMessage\(\s*\{\s*id:)\s*"
    + _Q
    + _KEY
    + _Q
)
_ATTR_KEYS = re.compile(
    r"""(?:i18nKey|i18n-key|v-t|data-i18n|keypath|id)\s*=\s*["']""" + _KEY + """["']"""
)
_PIPE = re.compile(_Q + _KEY + _Q + r"\s*\|\s*(?:translate|transloco|t)\b")
_INDEXER = re.compile(
    r"""(?:Localizer|localizer|L|T)\s*\[\s*["']""" + _KEY + r"""["']\s*\]"""
)
_MEMBER = re.compile(
    r"(?:\bR\.string\.|@string/|\bResources\.|\bStrings\.|\bAppLocalizations\.of\([^)]*\)!?\.|"
    r"\bS\.of\([^)]*\)\.|\bl10n\.|\bloc\.|\bcontext\.l10n\.)([A-Za-z_]\w*)"
)
# gettext and Laravel JSON catalogs are keyed by the source text itself.
_TEXT_CALLS = re.compile(
    r"""(?<![\w.])(?:_|gettext|ngettext|pgettext|__|trans|@lang|tr|qsTr)\(\s*["']((?:[^"'\\\n]|\\.){1,300})["']"""
)
_TEXT_LITERAL = re.compile(r"""\bText\(\s*["']([\w.\-]+)["']""")
_DYNAMIC = re.compile(
    r"""(?<![\w.])\$?t\(\s*`([\w.:\-]*)\$\{|(?<![\w.])\$?t\(\s*["']([\w.:\-]+)["']\s*\+"""
)
_BARE = re.compile(r"""(?<![\w.])\$?t\(\s*[A-Za-z_][\w.]*\s*[,)]""")
_NAMESPACE = re.compile(
    r"""(?:useTranslation|useTranslations|getTranslations|withTranslation|getFixedT)\(\s*"""
    r"""(?:\[\s*)?["']([\w\-./]+)["']"""
)


@dataclass
class KeyUsage:
    keys: set[str] = field(default_factory=set)
    """Keys named in full, as ``key`` and, under a namespace, ``ns.key``."""
    prefixes: set[str] = field(default_factory=set)
    """Static prefixes of keys built at run time."""
    dynamic: bool = False
    """Some call takes a bare variable: any key may be used."""

    def uses(self, key: str, catalog: str = "") -> bool:
        candidates = {key}
        if catalog:
            candidates.add(f"{catalog}.{key}")
            candidates.add(f"{catalog}:{key}")
        # i18next plural and context suffixes are chosen at run time.
        base = re.sub(r"_(zero|one|two|few|many|other|male|female)$", "", key)
        candidates.update({base, f"{catalog}.{base}" if catalog else base})
        if candidates & self.keys:
            return True
        return any(c.startswith(p) for c in candidates for p in self.prefixes if p)


def _norm(key: str) -> str:
    return key.replace(":", ".").strip(".")


def collect_usage(sources: dict[str, str]) -> KeyUsage:
    """The keys every source names, by every stack's own call."""
    usage = KeyUsage()
    for text in sources.values():
        namespaces = [_norm(m.group(1)) for m in _NAMESPACE.finditer(text)]
        named: set[str] = set()
        for pattern in (
            _STATIC_CALLS,
            _ATTR_KEYS,
            _PIPE,
            _INDEXER,
            _MEMBER,
            _TEXT_LITERAL,
            _TEXT_CALLS,
        ):
            for match in pattern.finditer(text):
                named.add(match.group(1))
        for key in named:
            usage.keys.add(key)
            usage.keys.add(_norm(key))
            for ns in namespaces:
                usage.keys.add(f"{ns}.{_norm(key)}")
        for match in _DYNAMIC.finditer(text):
            prefix = _norm(match.group(1) or match.group(2) or "")
            if not prefix:
                usage.dynamic = True
                continue
            usage.prefixes.add(prefix)
            for ns in namespaces:
                usage.prefixes.add(f"{ns}.{prefix}")
        if _BARE.search(text):
            usage.dynamic = True
    return usage
