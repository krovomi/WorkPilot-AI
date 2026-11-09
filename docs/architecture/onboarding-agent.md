# Agent d'onboarding : l'histoire du code

Page **Onboarding**. Un nouveau venu génère le paquet d'onboarding de son projet : visite guidée,
architecture, quiz, premières tâches, glossaire, et depuis #349 **l'histoire du code** (points chauds,
zones fragiles, décisions de l'équipe), une **visite par rôle**, la **régénération automatique** quand
la forme du projet change et un **export** Markdown ou page web.

Tout est lu dans le dépôt, sans modèle, de la même façon sur toutes les stacks. Le modèle actif
n'intervient que si on lui demande de raconter les chapitres en prose.

## Ce qui est mesuré

| Module | Ce qu'il lit | Comment |
|---|---|---|
| `onboarding_agent/hotspots.py` | Points chauds | `git log --name-only` sur un an (commits et personnes par fichier), points de décision comptés hors commentaires (`if`, boucles, `case`, `catch`, `&&`, `||`, `??`, ternaire, `match`, `when`, `guard`…), zone sensible par chemin puis par code (sécurité, facturation, migrations, infrastructure), test qui nomme le fichier selon la convention de sa stack (`test_x.py`, `x.test.ts`, `XTests.cs`, `x_test.go`, `XSpec.kt`…). |
| `onboarding_agent/decisions.py` | Décisions | ADR (`docs/adr/`, `doc/adr/`, `docs/decisions/`, `adr/`, `ADR-*.md`…) : titre, `Status`, `Date` (Nygard et MADR) ; commits cassants des deux dernières années (`type!:` ou pied `BREAKING CHANGE:`) ; pièges et pratiques de la mémoire du projet (Brain, qui remplace Graphiti). |
| `onboarding_agent/story.py` | Chapitres, rôles, fraîcheur | Cinq chapitres dans l'ordre d'un collègue : organisation (par stack si le projet en a plusieurs), point de départ, module le plus critique, zones fragiles, décisions. Zone de chaque fichier (`ui`, `api`, `data`, `infra`, `docs`, `tests`, `general`) d'après son chemin et son extension. |
| `onboarding_agent/narrate.py` | Narration | Un paragraphe par chapitre, dans la langue de l'app, par `core.oneshot` (tout provider, Ollama compris). |

Le **risque** d'un fichier vaut `0,4 × churn + 0,3 × complexité` (chacun rapporté au maximum du dépôt)
`+ 0,2` s'il est en zone sensible `+ 0,1` s'il n'a pas de test ; seuls les fichiers au-dessus de 10
sont montrés, quinze au plus. Chaque ligne dit pourquoi, en chiffres.

Un dépôt sans historique git garde la complexité, les zones et les tests ; un dépôt sans ADR, sans
commit cassant et sans mémoire le dit au lieu d'inventer une décision.

## Visite par rôle

`role_tours` garde, pour chaque rôle, les étapes de sa zone et les étapes générales (README, points
d'entrée, commandes) :

| Rôle | Zones |
|---|---|
| Full stack | toute la visite |
| Frontend | `ui` |
| Backend | `api`, `data` |
| DevOps | `infra` |

Un rôle sans étape à lui voit toute la visite. Les points chauds de l'onglet « L'histoire du code »
suivent le même filtre.

« Je connais déjà le projet » masque la visite et le quiz ; la carte, l'histoire, les premières tâches
et le glossaire restent (préférence de l'ordinateur, `localStorage`).

## Régénération automatique

Après chaque génération, le runner garde la forme du projet dans `.workpilot/onboarding/tour.json` :
les modules (dossiers de deux niveaux au plus avec au moins trois fichiers de code) et les manifestes
(`package.json`, `*.csproj`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `pubspec.yaml`…).
Le fichier n'est jamais écrit à travers un lien symbolique.

À l'ouverture de la page, `onboarding_agent_runner.py --status` compare la forme actuelle à celle-là,
sans construire le paquet. Un module ou un manifeste apparu ou disparu rend la visite périmée : la page
la régénère et dit ce qui a changé. Une visite déjà faite mais absente de la session est refaite aussi
(c'est déterministe et ne coûte aucun token).

## Narration par le modèle

« Raconter avec l'IA » lance `--narrate --language en|fr`. Les faits des chapitres viennent du dépôt
(noms de fichiers, sujets de commits, titres d'ADR) : ils entrent dans le prompt par `quote_untrusted`,
comme données (S2). La réponse est réduite à du texte : un paragraphe par chapitre connu, sans balisage,
sans lien, 900 caractères au plus. Un chapitre sans réponse garde ses lignes mesurées.

## Export

Le renderer écrit le document dans la langue de l'app, pour le rôle choisi (chapitres et leur narration,
visite, points chauds, commandes, conventions, quiz avec réponses, premières tâches, glossaire) et
l'envoie en chaînes simples. Le main (`main/onboarding-agent/export-document.ts`) revalide et borne la
requête (S6), retire les caractères de contrôle, échappe chaque chaîne pour son format et enregistre le
fichier choisi dans la boîte de dialogue. La page web porte une CSP `default-src 'none'` : ni script,
ni ressource distante, ni formulaire.

## IPC

| Canal | Ce qu'il fait |
|---|---|
| `onboardingAgent:run` | Génère le paquet (avec `story` et `freshness`). |
| `onboardingAgent:status` | Dit si la dernière visite est périmée. |
| `onboardingAgent:narrate` | Raconte les chapitres (`en` ou `fr`). |
| `onboardingAgent:export` | Boîte d'enregistrement puis fichier Markdown ou HTML. |

Le chemin de projet de chaque canal passe par `resolveKnownProject` : seul un projet ajouté à l'app est
analysé.

## Hors périmètre

- Score de dette de Self-Healing et incidents récents : pas de source fiable commune à toutes les stacks.
- Mise en évidence de lignes dans l'éditeur : la visite nomme les fichiers.
- Métriques d'usage (tours complétés, temps jusqu'au premier commit).
