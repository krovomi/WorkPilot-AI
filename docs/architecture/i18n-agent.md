# Agent i18n (#346)

La page Analyse i18n lit le code et les catalogues du projet sur toutes les stacks, dit ce qui
manque, ce qui est mort et ce qui est faux, et propose une clé pour chaque texte codé en dur.
Aucun modèle n'est appelé pour cela. Le seul appel à un modèle est la traduction des clés
manquantes, demandée par un bouton, faite sur une carte de revue.

```
apps/backend/i18n_agent/
  catalogs.py      les catalogues de chaque stack, leur langue, leur format
  i18n_scanner.py  le texte codé en dur, la comparaison des langues (API inchangée)
  usage.py         les clés que le code nomme, par l'appel de chaque stack
  keys.py          la clé proposée dans le style du projet, et l'appel à coller
  parity.py        variables, recopies, pluriels CLDR, côtés physiques (droite à gauche)
  writers.py       l'ajout de clés dans le format du fichier, sans réécrire le reste
  translator.py    la traduction par le modèle actif, vérifiée clé par clé
  audit.py         le rapport complet, et la traduction des clés manquantes
apps/backend/runners/i18n_runner.py    rapport (`I18N_RESULT`) et `--translate` (`I18N_TRANSLATE`)
apps/frontend/src/main/i18n-agent/translate-run.ts   la carte de revue, le runner dans son worktree
```

## Les catalogues de toutes les stacks

JSON (dossiers i18next `locales/fr/*.json` ou fichiers `i18n/fr.json`), ARB Flutter, RESX .NET,
`strings.xml` Android, `.strings` iOS, XLIFF Angular, gettext `.po`, `.properties` Java, YAML
Rails, PHP Laravel. Un catalogue neutre (`Strings.resx`, `values/strings.xml`,
`messages.properties`) appartient à la langue de référence. Les catalogues viennent du dépôt
analysé : ils sont lus comme des données, le XML par defusedxml.

`en.yml` et `fr.yml` de Rails sont un même catalogue (`messages`), `devise.fr.yml` est
`devise` : avant, chaque fichier portait le nom de sa langue et la comparaison ne trouvait rien.

## Les clés que le code utilise

`usage.py` reconnaît l'appel de chaque stack : `t()`, `$t()`, `i18n.t`, `<Trans i18nKey>`,
`useTranslation("ns")` (qui met `t("b")` sous `ns`), le pipe Angular `| translate`,
`translate.instant`, `Localizer["Key"]`, `Resources.Key`, `R.string.key`, `@string/key`,
`NSLocalizedString`, `String(localized:)`, `AppLocalizations.of(context)!.key`, `l10n.key`,
`_()` / `gettext`, `__()` / `trans` / `@lang`, `I18n.t`, `getString`. Une fonction nue (`t`,
`_`) ne compte pas quand elle est la méthode d'autre chose.

Une clé *orpheline* est une clé de la référence qu'aucune source ne nomme. Une clé construite à
l'exécution (`` t(`rules.${id}.title`) ``, `t("errors." + code)`) marque tout son préfixe comme
utilisé. Un appel dont la clé est une variable (`t(label)`) peut tout nommer : les orphelines
d'un tel projet sont « peut-être inutilisées » et le disent. Si aucune source ne nomme aucune
clé, les catalogues vivent ailleurs et aucune orpheline n'est signalée.

## La clé proposée

Pour `components/settings/PrivacyPanel.tsx` et « Share anonymous benchmarks » :
`settings.privacyPanel.shareAnonymousBenchmarks`. Le dossier et le composant donnent le début,
les mots du texte la fin. Le style suit les clés existantes : camelCase, snake_case ou
kebab-case (les suffixes de pluriel `_one`/`_other` ne comptent pas comme du snake_case),
pointées ou plates (Android, iOS, .NET, ARB sont plats : `login_screen_sign_in`). Une clé qui
existe déjà avec le même texte est reprise plutôt que dupliquée.

Les interpolations prennent la forme du catalogue : `{{name}}` pour i18next, `{name}` pour ICU
et ARB, `%s` pour Android, `%@` pour iOS, `{0}` pour .NET et Java, `:name` pour Laravel,
`%{name}` pour Rails. L'appel à coller est celui de la stack (`{t("…")}`, `{{ $t('…') }}`,
`@Localizer["…"]`, `getString(R.string.…)`…).

Les fichiers de test, de stories et de fixtures ne sont pas lus, ni les lignes qui écrivent un
log (`console.`, `logger.`, `print(`, `Log.`…).

## Ce qui est faux en plus de manquer

- **Variables** : le même ensemble dans chaque langue (`{{name}}`, `{name}`, `%1$s`, `{0}`,
  `:name`, `%{name}`), sinon l'app affiche une variable brute ou plante. Les branches d'un
  pluriel ICU peuvent différer ; une forme de pluriel i18next peut ajouter ou retirer le compte
  (« One file » / « {{count}} fichier »).
- **Recopies** : une phrase de trois mots ou plus identique à la référence. Un libellé court
  identique dans les deux langues (« Description », « OK ») n'est pas signalé.
- **Pluriels** : les catégories CLDR de chaque langue (arabe six, polonais et russe quatre,
  français et anglais deux, japonais une), en suffixes i18next ou en messages ICU. Le `many` du
  français, de l'espagnol, de l'italien, du portugais et du catalan n'est demandé qu'aux
  catalogues qui l'utilisent déjà ; les autres reçoivent une seule note. Une forme qu'une langue
  n'utilise pas (`_one` en japonais) n'est ni « manquante » ni comptée dans sa complétude.
- **Droite à gauche** : quand une langue RTL est livrée (arabe, hébreu, persan, ourdou…), les
  styles qui fixent un côté (`margin-left`, `text-align: left`, Tailwind `ml-4`, `left-0`) sont
  signalés avec leur équivalent logique (`margin-inline-start`, `ms-4`).

La complétude d'une langue est le nombre de clés présentes et traduites (les recopies retirées)
sur les clés dont elle a besoin.

## La traduction, sur une carte de revue

Le bouton ouvre une carte de revue (`openReviewRun`, source `i18n` : un worktree sur la branche
de la carte), lance `i18n_runner.py --translate` dans ce worktree, puis commite et met la carte
en revue. Rien n'est écrit dans le dossier du projet (voir
[generated-review](generated-review.md)). Une exécution qui n'a rien ajouté retire sa carte.

Les textes de référence partent au modèle actif (`core.oneshot` : tout provider, Ollama compris)
par lots de 40, 400 clés au plus par exécution, cités comme données (`quote_untrusted`) avec
leur clé et leur catalogue. La réponse est un objet JSON ; chaque traduction n'est gardée que si
elle garde exactement les variables et les balises de la référence et reste de la taille d'un
libellé. Les autres sont écartées et comptées : la clé reste manquante.

`writers.py` n'ajoute que les clés absentes et ne réécrit jamais une valeur. JSON et ARB gardent
leur ordre et leur indentation (un JSON aux clés pointées reste plat) ; `.properties` et
`.strings` reçoivent des lignes échappées en fin de fichier ; `strings.xml` et `.resx` des
entrées avant leur balise fermante, échappées pour XML (et `\'`, `\"`, `\@` pour Android). Un
fichier lié n'est pas écrit. YAML, XLIFF, gettext et PHP ne sont pas écrits : leur structure
(commentaires, unités, formes de pluriel) ne survit pas à un écrivain simple, la page les liste.

Un projet serveur n'a pas ses catalogues sur l'ordinateur : le bouton y est désactivé.

## Non couvert

Captures d'écran de contexte pour les traducteurs, DeepL et Google Translate (le modèle actif
seulement), migration assistée d'espaces de noms.
