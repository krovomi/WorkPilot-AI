# Agent d'accessibilité (#391)

La page Accessibilité vérifie les critères WCAG 2.2 que la source permet de juger, note le
projet de 0 à 100, ouvre l'application lancée pour voir ce que rencontrent un clavier et un
lecteur d'écran, et fait les corrections simples sur une carte de revue. Aucun modèle n'est
appelé, sauf si la personne demande des textes alternatifs rédigés par l'IA.

```
apps/backend/accessibility_agent/
  markup.py               un lecteur tolérant pour toutes les syntaxes de gabarit
  rules.py                les règles WCAG, sur les éléments et le CSS
  contrast.py             le rapport de contraste du standard, couleurs, variables, jetons
  score.py                le score, sa ventilation par critère et par page, l'historique
  fixer.py                les corrections dérivées de la source, et les alt par l'IA
  generated.py            le score du code qu'Import Design vient de générer
  accessibility_scanner.py  l'API du scanner (inchangée pour ses appelants)
apps/backend/runners/accessibility_runner.py   analyse (`A11Y_RESULT`) et correction (`--fix`)
apps/frontend/src/main/accessibility/
  dynamic-scan.ts         la fenêtre cachée et le protocole DevTools
  dynamic-checks.ts       les règles sur la trace de la page (pures, testées sans navigateur)
  fix-run.ts              la carte de revue, le runner dans son worktree
  report-export.ts        HTML, CSV, PDF
```

## Lire toutes les stacks de la même façon

`markup.py` lit HTML, JSX/TSX, Vue, Svelte, Astro, les gabarits Angular, Razor/Blazor,
PHP/Blade, Twig, ERB et Handlebars. Ce n'est pas un parseur validant : il trouve les éléments,
leurs attributs et leur contenu, garde les numéros de ligne (les commentaires sont remplacés par
des espaces) et ne lève jamais d'erreur sur un balisage cassé.

Une liaison devient l'attribut qu'elle pose, marqué « lié » : `:alt` et `v-bind:alt` (Vue),
`[alt]` et `[attr.alt]` (Angular), `alt={…}` (JSX, Svelte), `alt="@x"` (Razor). Les événements
aussi : `onClick`, `@click`, `(click)`, `on:click`, `@onclick` sont tous `onclick`. Dans un
fichier JS/TS, un `<` ne commence une balise qu'après `(`, `=`, `return`, `{`, `?`, `&&`… :
`a < b` et `useState<string>()` ne sont pas des balises.

## Se taire quand la source ne sait pas

Une fausse alerte coûte plus qu'une alerte manquée, que le scan dynamique peut encore attraper.
Une règle ne dit rien quand :

- l'attribut est posé par une expression (sa valeur est inconnue, pas absente) ;
- l'élément reçoit des props étalées (`{...props}`, `v-bind="$attrs"`) ;
- un bouton ou un lien contient un composant qui n'est pas une icône connue (lucide, heroicons,
  react-icons, MUI, Font Awesome, Tabler…) : il peut rendre un texte ;
- un `label for` est lié, la taille d'une cible dépend d'une marge interne, une couleur n'est pas
  une couleur simple (`currentColor`, dégradé, fond transparent).

Une violation dans un balisage conditionnel (`v-if`, `*ngIf`, `{cond && …}`, `@if`, `{#if}`)
porte la note « conditionnel » : il peut ne pas s'afficher. Sur un composant importé d'un paquet
(`next/image`…), la note « composant externe » : on le corrige là où on l'utilise, ou on le
signale à son mainteneur.

## Les règles

| Critère | Niveau | Règles |
|---|---|---|
| 1.1.1 | A | `img-alt` (img, area, input image, `Image`/`Img`/`Avatar` de composant), `img-alt-meaningful`, `svg-img-name` |
| 1.2.2 | A | `video-captions` (pas pour une vidéo `muted`) |
| 1.3.1 | A | `control-label` (label lié, label englobant, aria ; un placeholder n'en est pas un), `heading-order` |
| 2.1.1 | A | `click-without-keyboard`, `anchor-is-valid` |
| 2.4.1, 2.4.2, 2.4.3 | A | `skip-link` (une page avec `<nav>` et `<main>`), `page-title`, `tabindex-positive` |
| 3.1.1 | A | `page-lang`, aussi listé à part dans le rapport |
| 4.1.2 | A | `button-name`, `link-name`, `aria-role` (rôles WAI-ARIA 1.2), `aria-hidden-focus`, `iframe-title` |
| 1.4.4 | AA | `meta-viewport` (zoom bloqué) |
| 2.4.7 | AA | `focus-visible` : `:focus { outline: none }` sans remplacement ni `:focus-visible`, `outline-none` Tailwind sans anneau |
| 1.4.3 / 1.4.6 | AA / AAA | `color-contrast`, `color-contrast-enhanced` |
| 2.5.8 / 2.5.5 | AA / AAA | `target-size` (24 px), `target-size-enhanced` (44 px), les liens dans un texte exceptés |

Le contraste vient d'une règle CSS (fichiers `.css`, `.scss`, `.less`… et blocs `<style>`) qui
pose les deux couleurs, d'un `style` en ligne, ou des classes : les valeurs arbitraires
Tailwind (`text-[#777]`) et les jetons du système de design que la personne associe à une couleur
dans `.workpilot/a11y-tokens.json` (`{"tokens": {"text-muted": "#6b7280"}}`). Les variables CSS,
SCSS et Less du fichier sont résolues. Un texte large (24 px, ou 18,66 px en gras) demande 3:1.

## Le score

Chaque violation pèse selon sa gravité (critique 10, sérieuse 6, modérée 3, mineure 1) et le
score vaut `100 × K / (K + poids)`, avec `K = 10` par fichier analysé. Dix fichiers et une
violation critique donnent 91. La même formule note chaque critère et chaque page, et le même code
a toujours le même score : chaque analyse ajoute une ligne à
`.workpilot/accessibility/history.jsonl` (200 gardées) et la page montre la tendance.

## Le scan dynamique

Dans le main Electron, jamais dans le renderer. L'adresse est celle de l'App Emulator, ou une
adresse tapée qui doit être sur cet ordinateur (`localhost`, `*.localhost`, `127.x`, `[::1]`,
sans identifiants). La fenêtre est cachée, sans preload ni Node, en bac à sable, dans une session
en mémoire vidée après l'analyse ; elle refuse les permissions, les fenêtres et toute navigation
ou redirection vers une autre origine. Par le protocole DevTools, l'analyse lit l'arbre
d'accessibilité, appuie sur Tab jusqu'à 60 fois, mesure les couleurs rendues et vérifie que le
focus reste dans une boîte de dialogue modale ouverte. Ce que la page répond est la sortie du
code du projet : une donnée, remise en champs bornés (`sanitizeTrace`) avant toute règle.

## Les corrections

Les corrections simples sont dérivées de la source, jamais inventées : `alt` depuis le nom du
fichier, le `title` ou la `figcaption` voisine ; `aria-label` d'un champ depuis son placeholder,
son `name` ou son `id` ; `aria-label` d'un bouton-icône depuis le nom de l'icône (`TrashIcon` →
« Trash ») ; `lang` dans la langue de l'application ; `tabindex="0"`. Sans rien à dériver, pas de
correction : le rapport dit quoi écrire.

Cocher des corrections puis « Corriger sur une branche de revue » ouvre une carte de revue
(`main/generated-review/`, source `accessibility`) : le runner réanalyse le worktree de la carte,
fait les corrections qu'il y retrouve, et la carte est commitée et mise en revue. Rien n'est
écrit dans le dossier du projet. Une correction que la branche ne contient plus (le code a changé)
est signalée « non retrouvée » ; une analyse qui ne change rien retire sa carte. Avec « Rédiger
les textes alternatifs avec le modèle d'IA », le fournisseur actif reçoit, comme données citées
(`quote_untrusted`), le fichier, la source de l'image et le texte voisin, et répond un JSON ; une
réponse absente ou malformée laisse les textes dérivés.

## Import Design

Le résultat d'Import Design porte le score de son balisage généré (`generated.py`), affiché à
l'étape de revue avant que le code ne parte sur sa carte.

## Limites

Les gabarits rendus côté serveur ne sont vus qu'à travers leur source ; l'ordre visuel d'un
`flex-direction: row-reverse` ou d'une grille n'est jugé que par le scan dynamique. L'alt par un
modèle de vision n'est pas branché : le modèle lit le contexte textuel. Un projet du serveur est
analysé sur le serveur, mais ni scanné en dynamique ni corrigé depuis cet ordinateur.
