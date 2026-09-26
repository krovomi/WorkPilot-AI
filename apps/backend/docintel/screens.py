"""What a screen's text says about the screen — read without a model.

A capture of the running application is the one piece of evidence QA gets
that is not the code: what a person would actually see. Three defects show on
it and nowhere else, and all three are i18n defects no test in a repository
catches, because each test runs in one locale and asserts one string:

- a **translation key** shown instead of its text (`tasks:detail.title`,
  `HOME.WELCOME`, `{{count}}`, `???label.save???`, `[missing "fr.x" translation]`)
  — the i18next, Angular, Spring, Rails, Android and ICU spellings, because the
  key leaks the same way whatever the stack;
- a **language** that is not the screen's — an English button on a French
  page, a whole screen still in the source language;
- a **truncated** label — cut with an ellipsis where the full text is known
  (the mockup, the base branch), or running off the edge of the capture.

And, for a device capture, *which* screen it is: the app's own screen, a
crash dialog, an error page, or a sign-in wall that stood between the capture
and the feature. A capture of a login page is not evidence the feature works;
reading it as such is how "verified on device" gets written about a screen
nobody saw.

Every detector here is a table of patterns, tried on text that was already
masked and scanned (`preflight._protect`). They report; they never decide.
OCR misreads, and the QA reviewer is told so.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from urllib.parse import parse_qs, urlsplit

from .engines.base import OcrBox
from .labels import normalize_label, same_label

# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

SEVERITIES = ("high", "medium", "low")


@dataclass
class ScreenFinding:
    #: ``untranslated-key``, ``interpolation``, ``language``,
    #: ``foreign-label``, ``truncated``, ``ellipsis``, ``clipped``,
    #: ``overflow``, ``crash``, ``error-page``, ``login``, ``blank``,
    #: ``expected-screen``, ``mockup-missing``, ``mockup-near``,
    #: ``placeholder``.
    kind: str
    severity: str
    #: The text on the screen the finding is about (masked).
    text: str = ""
    #: A short, stable explanation: an expected label, a language code…
    detail: str = ""
    #: The capture it was read on, relative to its root.
    capture: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Untranslated keys
# ---------------------------------------------------------------------------

_FILE_EXTENSIONS = {
    "ts", "tsx", "js", "jsx", "json", "html", "htm", "css", "scss", "cs", "py",
    "java", "kt", "swift", "dart", "go", "rs", "rb", "php", "md", "png", "jpg",
    "jpeg", "svg", "gif", "pdf", "xml", "yaml", "yml", "txt", "csv", "zip",
    "exe", "dll", "vue", "svelte", "cshtml", "razor", "xaml",
}  # fmt: skip
_TLDS = {
    "com", "org", "net", "io", "dev", "fr", "de", "es", "it", "uk", "eu", "co",
    "app", "ai", "be", "ch", "ca", "us", "info", "gov", "edu", "local", "nl",
}  # fmt: skip

#: `namespace:section.key` — i18next and every library copying its spelling.
_NAMESPACED = re.compile(r"(?<![\w/@.])([a-z][\w-]*):\s?([a-zA-Z][\w-]*(?:\.[\w-]+)+)")
#: `section.sub.key` — lower or camel case, at least three segments.
_DOTTED = re.compile(
    r"(?<![\w/@:.])([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){2,})(?![\w.]*@)"
)
#: `HOME.WELCOME_TITLE` — ngx-translate's convention.
_UPPER_DOTTED = re.compile(r"(?<![\w.])([A-Z][A-Z0-9_]+(?:\.[A-Z0-9_]{2,})+)(?![\w.])")
_MARKERS = (
    re.compile(r"\[missing \"[^\"]{1,120}\" translation\]", re.IGNORECASE),  # Rails
    re.compile(r"\?{2,3}[\w.-]{2,120}\?{2,3}"),  # Spring / JSF
    re.compile(r"\bMISSING[_ ]TRANSLATION\b", re.IGNORECASE),
    re.compile(r"@string/\w+"),  # Android resource reference
)
_INTERPOLATION = (
    re.compile(r"\{\{\s*[\w.$]+\s*\}\}"),  # {{name}} — i18next, Angular, Vue
    re.compile(r"\$\{[\w.]+\}"),  # ${name}
    re.compile(
        r"(?<![\w{$])\{[a-zA-Z_]\w*(?:,\s*(?:plural|select|number)[^}]*)?\}(?!\})"
    ),  # ICU
    re.compile(r"%\(\w+\)[sd]|%[0-9]?\$?[sd@](?!\w)"),  # printf, gettext, Apple
    re.compile(r"(?<!\w)\{\d\}"),  # .NET String.Format
)


def _plausible_key(token: str) -> bool:
    segments = token.split(".")
    if any(not s or s.isdigit() for s in segments):
        return False
    if segments[-1].lower() in _FILE_EXTENSIONS | _TLDS or segments[0] == "www":
        return False
    # A key is written by a developer: an underscore, a camelCase hump, or
    # enough segments that a sentence would never produce it.
    return (
        len(segments) >= 3
        or "_" in token
        or any(re.search(r"[a-z][A-Z]", s) for s in segments)
    )


def untranslated(line: str) -> list[tuple[str, str]]:
    """(kind, token) for each raw key or placeholder on a line of the screen."""
    found: list[tuple[str, str]] = []
    for match in _NAMESPACED.finditer(line):
        if match.group(1).lower() not in ("http", "https", "mailto", "file"):
            found.append(("untranslated-key", match.group(0).replace(" ", "")))
    for pattern in (_DOTTED, _UPPER_DOTTED):
        for match in pattern.finditer(line):
            token = match.group(1)
            if _plausible_key(token) and not any(token in f for _, f in found):
                found.append(("untranslated-key", token))
    for pattern in _MARKERS:
        found.extend(("untranslated-key", m.group(0)) for m in pattern.finditer(line))
    for pattern in _INTERPOLATION:
        found.extend(("interpolation", m.group(0)) for m in pattern.finditer(line))
    return found


# ---------------------------------------------------------------------------
# Language
# ---------------------------------------------------------------------------

#: Function words and the words user interfaces are made of, per language.
#: A word listed under two languages is dropped from both at import: it is
#: evidence of neither.
_LEXICON: dict[str, set[str]] = {
    "en": set(
        "the and of to is are with for your you this that from not be have "
        "will can on at by or it all new more please here "
        "save cancel delete remove edit add close open settings search sign "
        "log in out next back submit continue loading welcome password "
        "username account home yes create update send show hide view details "
        "order orders customer customers user users help profile logout "
        "forgot sign-in signup register total price name date status "
        "select choose upload download error warning success confirm "
        "message messages today yesterday week month year change changes "
        "items item cart checkout pay payment address city country phone".split()
    ),
    "fr": set(
        "le la les des du de et est sont avec pour votre vous ce cette dans "
        "pas une un sur au aux par ou tout tous nouveau nouvelle plus "
        "enregistrer annuler supprimer modifier ajouter fermer ouvrir "
        "paramètres rechercher connexion déconnexion connecter suivant "
        "précédent retour valider continuer chargement bienvenue passe "
        "utilisateur compte accueil oui non créer envoyer afficher masquer "
        "voir détails commande commandes client clients utilisateurs aide "
        "profil oublié inscription prix nom état statut sélectionner choisir "
        "télécharger erreur avertissement succès confirmer aujourd'hui hier "
        "semaine mois année panier paiement adresse ville pays téléphone "
        "articles article résultats aucun".split()
    ),
    "de": set(
        "der die das und ist sind mit für ihr ihre sie nicht ein eine auf "
        "zu von im den dem alle neu mehr bitte speichern abbrechen löschen "
        "bearbeiten hinzufügen schließen öffnen einstellungen suchen anmelden "
        "abmelden weiter zurück absenden fortfahren laden willkommen passwort "
        "benutzername konto startseite ja nein erstellen aktualisieren senden "
        "anzeigen ausblenden bestellung bestellungen kunde kunden benutzer "
        "hilfe profil vergessen registrieren preis datum fehler warnung "
        "bestätigen heute gestern woche monat jahr warenkorb kasse zahlung "
        "adresse stadt telefon".split()
    ),
    "es": set(
        "el los las y es son con para su usted esta este del en no una uno "
        "por todo todos nuevo nueva más guardar cancelar eliminar editar "
        "añadir agregar cerrar abrir configuración buscar iniciar sesión "
        "siguiente atrás enviar continuar cargando bienvenido contraseña "
        "usuario cuenta inicio sí crear actualizar mostrar ocultar ver "
        "detalles pedido pedidos cliente clientes usuarios ayuda perfil "
        "olvidó registrarse precio nombre fecha estado seleccionar elegir "
        "descargar advertencia éxito confirmar hoy ayer semana mes año "
        "carrito pago dirección ciudad país teléfono".split()
    ),
    "it": set(
        "il lo gli e è sono con per tuo tua questo questa del della nel non "
        "una uno su da tutto tutti nuovo nuova più salva annulla elimina "
        "modifica aggiungi chiudi apri impostazioni cerca accedi esci "
        "successivo indietro invia continua caricamento benvenuto utente "
        "account sì crea aggiorna mostra nascondi dettagli ordine ordini "
        "clienti utenti aiuto profilo dimenticato registrati prezzo nome "
        "data stato seleziona scegli scarica errore avviso conferma oggi "
        "ieri settimana mese anno carrello pagamento indirizzo città paese".split()
    ),
    "pt": set(
        "o os e é são com para seu sua você este esta do da no na não uma um "
        "em por todo todos novo nova mais salvar cancelar excluir editar "
        "adicionar fechar abrir configurações pesquisar entrar sair próximo "
        "voltar enviar continuar carregando bem-vindo senha usuário conta "
        "início sim criar atualizar mostrar ocultar detalhes pedido pedidos "
        "clientes usuários ajuda perfil esqueceu cadastrar preço nome data "
        "selecionar escolher baixar erro aviso sucesso confirmar hoje ontem "
        "semana mês ano carrinho pagamento endereço cidade país telefone".split()
    ),
    "nl": set(
        "de het een en is zijn met voor uw jouw je dit dat van niet op te "
        "door alle nieuw meer opslaan annuleren verwijderen bewerken "
        "toevoegen sluiten openen instellingen zoeken inloggen uitloggen "
        "volgende terug verzenden doorgaan laden welkom wachtwoord "
        "gebruikersnaam startpagina ja nee maken bijwerken tonen verbergen "
        "bekijken bestelling bestellingen klant klanten gebruikers hulp "
        "profiel vergeten registreren prijs naam datum fout waarschuwing "
        "bevestigen vandaag gisteren week maand jaar winkelwagen betaling "
        "adres stad land telefoon".split()
    ),
}
#: Words every UI uses whatever its language.
_INTERNATIONAL = {"ok", "email", "e-mail", "menu", "info", "logo", "admin", "id", "api"}


def _prune(lexicon: dict[str, set[str]]) -> dict[str, frozenset[str]]:
    counts: dict[str, int] = {}
    for words in lexicon.values():
        for word in words:
            counts[word] = counts.get(word, 0) + 1
    return {
        lang: frozenset(w for w in words if counts[w] == 1 and w not in _INTERNATIONAL)
        for lang, words in lexicon.items()
    }


LEXICON = _prune(_LEXICON)
LANGUAGES = tuple(LEXICON)
_WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*")
_MIN_EVIDENCE = 3


def _tokens(text: str) -> list[str]:
    return [
        t.replace("’", "'")
        for t in _WORD.findall(unicodedata.normalize("NFC", text.lower()))
    ]


def language_scores(text: str) -> dict[str, int]:
    scores = dict.fromkeys(LANGUAGES, 0)
    for token in _tokens(text):
        for lang, words in LEXICON.items():
            if token in words:
                scores[lang] += 1
    return scores


def detect_language(text: str) -> tuple[str, float]:
    """(language, confidence), or ("", 0.0) when the words do not decide it.

    A screen is short and much of it is names and numbers, so the answer needs
    at least three words of evidence and twice the runner-up's score. Below
    that, "undetermined" is the honest answer and no finding is drawn from it.
    """
    scores = language_scores(text)
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, top = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0
    if top < _MIN_EVIDENCE or top < 2 * second:
        return "", 0.0
    return best, round(top / max(sum(scores.values()), 1), 2)


def label_language(label: str) -> str:
    """The language one label is unambiguously in, else ""."""
    scores = language_scores(label)
    hits = [lang for lang, n in scores.items() if n]
    return hits[0] if len(hits) == 1 else ""


def primary(locale: str) -> str:
    """`fr-FR`, `fr_CA`, `FR` -> `fr`; "" when it is not a locale."""
    match = re.match(
        r"^([a-zA-Z]{2,3})(?:[-_][A-Za-z0-9]{2,8})*$", (locale or "").strip()
    )
    return match.group(1).lower() if match else ""


_LOCALE_PARAMS = ("lang", "locale", "culture", "ui-culture", "hl", "lng", "language")
_LOCALE_SEGMENT = re.compile(r"^[a-z]{2}(?:[-_][A-Za-z]{2})?$")


def locale_from_url(url: str) -> str:
    """The locale a URL names, by query parameter or first path segment."""
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return ""
    query = parse_qs(parts.query)
    for key in _LOCALE_PARAMS:
        for value in query.get(key, []):
            if primary(value):
                return value
    first = next((s for s in parts.path.split("/") if s), "")
    if _LOCALE_SEGMENT.match(first) and primary(first) in LANGUAGES:
        return first
    return ""


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------

_ELLIPSIS = re.compile(r"^(?P<head>.{2,}?)\s*(?:…|\.\.\.)$")
_OVERFLOW = re.compile(
    r"(?:RenderFlex|BOTTOM|RIGHT|TOP|LEFT)\s+OVERFLOWED\s+BY\s+[\d.]+\s+PIXELS",
    re.IGNORECASE,
)
#: A trailing ellipsis a designer meant: work in progress, not a cut label.
_INTENTIONAL = re.compile(
    r"^(?:loading|chargement|cargando|laden|caricamento|carregando|laden|please wait|"
    r"veuillez patienter|searching|recherche en cours|saving|enregistrement|"
    r"processing|traitement|more|plus|voir plus|see more|read more|lire la suite)\b",
    re.IGNORECASE,
)


def truncations(
    labels: list[str],
    known: list[str],
    *,
    boxes: tuple[OcrBox, ...] | list[OcrBox] = (),
    width: int = 0,
) -> list[ScreenFinding]:
    """Labels that were cut, with the evidence each one has.

    ``truncated`` when a label the task *should* show (the mockup, the base
    branch) starts with what is visible and goes on; ``ellipsis`` when only
    the ellipsis says so; ``clipped`` when a word runs to the capture's edge.
    """
    findings: list[ScreenFinding] = []
    for label in labels:
        if _OVERFLOW.search(label):
            findings.append(
                ScreenFinding("overflow", "medium", label, "layout-overflow")
            )
            continue
        match = _ELLIPSIS.match(label.strip())
        if not match or _INTENTIONAL.match(label.strip()):
            continue
        head = normalize_label(match.group("head"))
        full = next(
            (
                k
                for k in known
                if len(normalize_label(k)) > len(head)
                and normalize_label(k).startswith(head)
            ),
            "",
        )
        if full:
            findings.append(ScreenFinding("truncated", "medium", label, full))
        else:
            findings.append(ScreenFinding("ellipsis", "low", label))
    if width > 0:
        for box in boxes:
            if box.left > 0 and box.left + box.width >= width - 2 and box.text.strip():
                findings.append(ScreenFinding("clipped", "low", box.text, "right-edge"))
    return findings


# ---------------------------------------------------------------------------
# Which screen is this?
# ---------------------------------------------------------------------------

_CRASH = re.compile(
    r"has stopped|keeps stopping|isn['’]t responding|is not responding|app not responding"
    r"|s['’]est arrêtée?|continue de s['’]arrêter|ne répond pas|a cessé de fonctionner"
    r"|wurde beendet|reagiert nicht|se ha detenido|no responde|si è interrotta"
    r"|unhandled (?:js |promise )?(?:exception|rejection)|invariant violation"
    r"|render error|unable to load script|exception caught by|fatal exception"
    r"|application error: a client-side exception|unhandled runtime error"
    r"|something went wrong",
    re.IGNORECASE,
)
_ERROR_PAGE = re.compile(
    r"an unhandled exception occurred while processing the request"
    r"|server error in ['‘]/['’] application|whitelabel error page"
    r"|internal server error|traceback \(most recent call last\)"
    r"|\bcannot (?:get|post) /|\b(?:404|500|502|503)\b.{0,24}(?:not found|error|bad gateway|unavailable)"
    r"|this site can['’]t be reached|err_connection_refused|page not found"
    r"|page introuvable|erreur interne du serveur|seite nicht gefunden"
    r"|página no encontrada",
    re.IGNORECASE,
)
_SIGN_IN = re.compile(
    r"\b(?:sign in|log in|login|se connecter|connexion|s['’]identifier|anmelden|einloggen"
    r"|iniciar sesi[oó]n|accedi|entrar|inloggen|aanmelden)\b",
    re.IGNORECASE,
)
_PASSWORD = re.compile(
    r"\b(?:password|mot de passe|passwort|kennwort|contrase[nñ]a|senha|wachtwoord)\b",
    re.IGNORECASE,
)
_PLACEHOLDER = re.compile(
    r"lorem ipsum|dolor sit amet|\bplaceholder\b|\bTODO\b|\bTBD\b|\bFIXME\b"
    r"|sample text|texte d['’]exemple|\bxxx+\b",
    re.IGNORECASE,
)


def screen_kind(text: str, labels: list[str]) -> tuple[str, str]:
    """(kind, evidence): ``crash``, ``error-page``, ``login``, ``blank`` or ``content``."""
    if not labels:
        return "blank", ""
    # The error page first: its wording ("unhandled exception") is a crash's too,
    # and the page is the more precise answer.
    for kind, pattern in (("error-page", _ERROR_PAGE), ("crash", _CRASH)):
        if match := pattern.search(text):
            return kind, match.group(0)
    sign_in, password = _SIGN_IN.search(text), _PASSWORD.search(text)
    if sign_in and password:
        return "login", f"{sign_in.group(0)} / {password.group(0)}"
    return "content", ""


def placeholders(text: str) -> list[str]:
    return [m.group(0) for m in _PLACEHOLDER.finditer(text)]


def expected_on_screen(expected: list[str], labels: list[str]) -> tuple[int, list[str]]:
    """(found, missing): which of the expected labels the screen shows."""
    missing = [e for e in expected if not any(same_label(e, label) for label in labels)]
    return len(expected) - len(missing), missing


# ---------------------------------------------------------------------------
# One screen, every check
# ---------------------------------------------------------------------------

_KIND_SEVERITY = {
    "crash": "high",
    "error-page": "high",
    "login": "medium",
    "blank": "medium",
}


def check_screen(
    text: str,
    labels: list[str],
    *,
    locale: str = "",
    known: list[str] | None = None,
    expected: list[str] | None = None,
    boxes: tuple[OcrBox, ...] | list[OcrBox] = (),
    width: int = 0,
    expect_login: bool = False,
    store: bool = False,
) -> tuple[list[ScreenFinding], dict]:
    """Every finding one capture supports, and what was read about it.

    `locale` is what the screen *should* be in. With none, the screen's own
    dominant language stands in, so a French screen with three English buttons
    is still reported — as mixed, not as wrong.
    """
    findings: list[ScreenFinding] = []
    for line in text.splitlines():
        for kind, token in untranslated(line):
            findings.append(ScreenFinding(kind, "medium", token))

    detected, confidence = detect_language(text)
    wanted = primary(locale)
    if wanted and wanted in LANGUAGES and detected and detected != wanted:
        findings.append(ScreenFinding("language", "medium", "", f"{detected}≠{wanted}"))
    reference = wanted if wanted in LANGUAGES else detected
    if reference and (not wanted or detected == wanted or not detected):
        for label in labels:
            lang = label_language(label)
            if lang and lang != reference:
                findings.append(
                    ScreenFinding("foreign-label", "low", label, f"{lang}≠{reference}")
                )

    findings.extend(truncations(labels, known or [], boxes=boxes, width=width))

    kind, evidence = screen_kind(text, labels)
    if kind in _KIND_SEVERITY and not (kind == "login" and expect_login):
        findings.append(ScreenFinding(kind, _KIND_SEVERITY[kind], evidence))

    info: dict = {
        "language": detected,
        "confidence": confidence,
        "locale": locale,
        "kind": kind,
    }
    if expected:
        found, missing = expected_on_screen(expected, labels)
        info["expected"] = {
            "found": found,
            "total": len(expected),
            "missing": missing[:20],
        }
        if found < max(1, (len(expected) + 1) // 2):
            findings.append(
                ScreenFinding(
                    "expected-screen", "medium", "", f"{found}/{len(expected)}"
                )
            )
    if store:
        findings.extend(
            ScreenFinding("placeholder", "medium", token)
            for token in placeholders(text)
        )
    return findings, info
