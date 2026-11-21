---
feature: Import Design, boucle de rendu et d'auto-correction
summary: >-
  Après la génération, Import Design rend le code dans un Chromium sans JavaScript ni réseau,
  le compare à la maquette hors zones masquées (pixels et SSIM, par zone) et fait corriger les
  écarts par le modèle de vision du provider choisi, jusqu'au seuil ou au budget. Sur demande,
  la version gardée est contrôlée à trois largeurs et au survol/focus, puis corrigée une fois
  d'après ces constats.
---

# Import Design : la boucle de rendu et d'auto-correction

Issue #379, lots 1 à 3. Le code généré depuis une maquette n'était jamais regardé : rien ne
disait qu'il lui ressemblait. La boucle le rend, mesure l'écart, montre au modèle ce qui diffère
et recommence, dans des bornes fixes. L'interrupteur est sur l'étape « Code » de la page.

```
apps/backend/design_to_code/          paquet feuille (n'importe que models_registry)
  render.py      capture Chromium headless (Playwright du venv)
  diff.py        score, zones, écarts, carte de diff
  feedback.py    retour structuré, prompt, réponse et modifications
  preview.py     miroir HTML statique pour les stacks qui ne se rendent pas telles quelles
  vision.py      quelle route de vision, ou pourquoi aucune
  loop.py        la boucle et ses règles d'arrêt
  budget.py      jetons lus chez le provider (ou estimés), coût, arrêt au budget
  passes.py      passe responsive (trois largeurs) et passe des états (survol, focus)
  pass_fix.py    une correction d'après les constats des passes, gardée si elle aide
apps/backend/services/design_to_code_render_loop.py   le raccord au service d'Import Design
apps/backend/services/design_to_code_edit_calls.py    la correction de l'abonnement, en schéma imposé
apps/backend/prompts/design_to_code_iteration.md      le prompt de correction
apps/backend/prompts/design_to_code_pass_fix.md       le prompt de correction d'après les passes
apps/frontend/.../design-import/IterationPanel.tsx    le panneau des itérations
apps/frontend/.../design-import/LoopReport.tsx        dépense, passe responsive, états
apps/frontend/.../design-import/LoopOptions.tsx       itérations, seuil, budgets, passes
apps/frontend/.../design-import/MaskLayer.tsx         les zones tracées sur la maquette
apps/frontend/src/main/design-render-loop-args.ts      les options revérifiées avant le runner
```

## Le déroulé

1. La version 0 est le code que le pipeline vient d'écrire. Le runner lance la boucle quand
   `--render-loop` est passé (la page l'envoie si l'interrupteur est actif) et que la génération
   a réussi ; chaque étape part sur le canal de progression existant (phase `render_loop`).
2. Chaque version est rendue aux dimensions de la cible (`viewport_for` : une capture Retina de
   2 400 px de large ou plus est rendue à la moitié, deux fois plus dense ; hauteur plafonnée à
   8 000 px).
3. Le diff donne un score par zone et un score global, et relève les écarts.
4. Si le score n'atteint pas le seuil, le modèle reçoit la cible, le rendu et la carte de diff
   côte à côte, plus le retour structuré, et répond par des modifications.
5. On garde la version au meilleur score, pas la dernière.

Arrêts (`loop.py`) : `converged` (seuil atteint, 0,95 par défaut), `max_iterations` (5
corrections par défaut), `budget` (vérifié avant chaque correction, `budget_kind` dit lequel :
`time`, 600 s par défaut ; `tokens`, 400 000 par défaut ; `cost`, 2 $ par défaut), `stalled`
(aucun gain de `min_gain` pendant `patience` corrections), `failed` (capture ou appel au modèle
en échec : la meilleure version déjà obtenue reste). Le runner borne ses options : 1 à 10
itérations, seuil de 0,5 à 0,999, temps de 30 à 3 600 s, jetons de 10 000 à 5 000 000, coût de
0,01 à 100 $ ; une valeur hors bornes est refusée par argparse, pas ramenée.

## Le rendu (`render.py`)

Le code généré n'est pas fiable : il vient d'un modèle qui a lu une image. Il est écrit dans un
dossier temporaire (chemins relatifs seulement, `..`, chemins absolus, lecteurs Windows et liens
sortants refusés), puis rendu dans un contexte Chromium avec `java_script_enabled=False` et
`offline=True`. Une route `**/*` n'accepte que les URL `file:` sous ce dossier ; tout le reste
est abandonné. Le navigateur est celui que la vérification connaît déjà
(`verify.devtools.chrome_executable`, passé par le raccord) ; sous root, `--no-sandbox`. Un
navigateur ou un Playwright absent donne un refus nommé (`no_browser`, `no_playwright`), pas une
erreur. Les polices de la typographie de la spec sont sondées sur un canvas : celles qui
manquent sont signalées, parce qu'un rendu avec une police de repli ne peut pas converger.

Une stack autre que HTML (React, Vue, Flutter, SwiftUI…) ne se rend pas sans sa chaîne
d'outils. Le lot 1 fait écrire une fois, par `core.oneshot` (qui suit la politique hors ligne),
un miroir HTML statique de ses fichiers (`workpilot-preview.html`). C'est lui qui est rendu ; les
corrections s'appliquent aux vrais fichiers et au miroir ensemble, et le miroir n'est jamais
livré. Le panneau dit quand le rendu est un miroir.

## Le diff (`diff.py`)

Algorithmique, sans modèle : numpy et Pillow, déjà dans le venv.

- **Correspondance des pixels** avec une tolérance par canal (12 ; 24 quand la cible est un
  JPEG, dont la compression bave sur les bords).
- **SSIM** sur des fenêtres de 8×8, calculé par image intégrale.
- **Score** : la moyenne des deux.
- **Zones** : les `bounds` des composants de la spec quand le modèle de vision les a donnés,
  sinon cinq bandes horizontales.
- **Masques** : les composants dont le type est dynamique (image, avatar, graphique, carte, date,
  vidéo…) sont exclus de la mesure ; le panneau les nomme. S'y ajoutent les zones que la personne
  trace sur la maquette (au plus `RENDER_LOOP_MAX_MASKS`, 12) : des fractions `x,y,w,h` que le
  main ne transmet que finies, dans `[0, 1]`, non vides et dans l'image (`--loop-mask`), et que
  le runner revérifie (argparse, même limite) ; le panneau en donne le nombre.
- **Écarts relevés** par zone en échec : couleur de fond (cible et rendu en hexadécimal),
  décalage (corrélation croisée des profils, en px, par axe), taille (étendue du contenu, par
  axe), sinon « structure ».

## Le retour et la correction (`feedback.py`, `vision.py`)

Le retour est un JSON neutre : zones en échec, la pire d'abord, et chaque écart en une phrase
(« background is #f08030 but should be #e63946 »). Le prompt range les fichiers dans des blocs
délimités et dit qu'ils sont des données ; la réponse attendue est
`{"edits": [{"path", "find", "replace"}], "notes": [...]}`. Une modification n'est appliquée
que si `path` est un fichier de la version et que `find` y apparaît exactement une fois ; sinon
elle est refusée avec sa raison (`unknown_file`, `not_found`, `ambiguous`), et une réponse
illisible ne change rien. Rechercher-remplacer plutôt que fichiers entiers : un fichier complet
dépasserait la réponse plafonnée d'un appel de vision et y serait tronqué.

**Réponse imposée** (`design_to_code_edit_calls.py`). Avec l'abonnement Claude, le modèle ne
répond pas en texte : la correction passe par `core.simple_client`, l'image en bloc de contenu
et `output_format` réglé sur le schéma JSON des modifications, que le SDK valide et redemande
(sa sortie structurée est un appel d'outil forcé, d'où deux tours). Le type d'agent est celui
de `commit_message`, sans aucun outil. La sortie structurée repasse par `parse_answer`, comme
toute réponse ; un modèle qui répond en texte quand même est lu de la même façon. Les autres
routes gardent le JSON dans le texte des appels de vision du service (voir « Pas encore fait »).

La route suit le provider choisi pour la page, sans jamais en prendre un autre : Claude (clé ou
abonnement), OpenAI (et Copilot), Google, Ollama, LM Studio, llama.cpp. Une clé absente, un provider sans route de
vision, ou un modèle que le registre marque texte seul (`supports_vision=False`,
`models_registry.vision_support`) est un refus avec sa raison, que la page traduit. Un provider local répond sur cette machine : Ollama par `docintel.engines.ollama_vision`, LM
Studio et llama.cpp par leur serveur compatible OpenAI, à l'adresse que donne
`offline_policy.local_endpoint` (boucle locale seulement, sans proxy ; une autre adresse est un
refus `local_unavailable`, détail `endpoint_not_loopback`). En hors-ligne strict
(`offline_policy.airgap_status`), la seule route est un modèle local, celui du provider choisi
s'il est local, sinon Ollama : aucune image ne quitte la machine. Un modèle local est au forfait
(`flat_rate`).
Une erreur du provider remonte comme « provider answered HTTP 500 », jamais avec le texte reçu.

## Le budget en jetons et en coût (`budget.py`)

Chaque correction est un appel de vision. Ses jetons sont ceux que le provider renvoie :
`read_usage` lit les quatre formes que reçoivent les appels du service (Anthropic, OpenAI,
Gemini, Ollama ; le résultat final du SDK pour l'abonnement Claude), que le service garde dans
`last_usage` après chaque appel. Une route qui n'en donne aucun (le modèle local par `docintel`)
est comptée par `estimate_usage` (4 caractères par jeton, une image à 750 px par jeton) et
marquée `estimated` : la page écrit « environ ».

Le coût n'est jamais deviné. Le raccord construit un `Pricing` depuis le catalogue des prix
(`cost_intelligence.catalog`) pour le modèle de la route : `priced` quand le catalogue a une
ligne, `flat_rate` pour l'abonnement Claude et pour un provider sans prix par jeton
(`FLAT_RATE_PROVIDERS`, dont Ollama), `unknown` sinon (Gemini 1.5 Flash, le modèle par défaut
de la route Google, n'a pas de ligne). Un coût inconnu s'affiche comme tel, et le budget en
coût n'est alors pas appliqué : le rapport dit `cost_budget_checked: false` plutôt que de
s'arrêter sur un chiffre inventé. Le budget en jetons, lui, vaut pour tous les providers.

La boucle s'arrête avant une correction qui, aussi grosse que la précédente, dépasserait un
budget : elle ne découvre pas le dépassement après coup. Le rapport donne `spend` (jetons
d'entrée et de sortie, coût, statut, bornes) et, par itération, `tokens` et `cost_usd`. Le
budget couvre les corrections, pas l'analyse ni la génération qui les précèdent.

## Les passes sur la version retenue (`passes.py`)

Demandées dans la page (cases « Passe responsive » et « Captures survol et focus »), elles
tournent une fois la boucle arrêtée, sur la version gardée, dans le même navigateur et par
`Renderer.open_page` : chaque page ouverte a les protections du rendu (JavaScript coupé,
réseau hors-ligne, `file:` sous le dossier de la version seulement). Les sondes sont des
fonctions de WorkPilot évaluées par Playwright ; les scripts de la page ne tournent pas et ne
peuvent donc rien changer à ce qu'elles lisent. Ce qu'elles renvoient vient du code généré :
typé, tronqué (60 caractères par libellé, 8 constats par sorte) avant d'entrer dans le rapport.
Une passe qui ne peut pas ouvrir la page dit pourquoi ; le résultat de la boucle reste.

**Responsive.** `BREAKPOINTS` fixe trois largeurs : mobile 390×844 (maquettes jusqu'à 599 px),
tablette 768×1024 (jusqu'à 1 023 px), bureau 1440×900. Celle dont la plage contient la largeur
de la maquette est rendue à la taille de la maquette et comparée à elle (score, écarts par
zone). Les deux autres n'ont pas de maquette : elles sont contrôlées seules, sur tout le
document, par une sonde du DOM : page plus large que l'écran (`overflow_px`) et éléments qui
dépassent le bord droit, texte coupé par une boîte qui ne déborde pas (`overflow` autre que
`visible`), éléments porteurs de texte ou de média qui se chevauchent (intersection d'au moins
16 px² et d'un quart du plus petit, sans relation de parenté). Les trois largeurs reçoivent ces
contrôles.

**États.** Au plus `MAX_STATE_ELEMENTS` (6) éléments interactifs visibles à l'écran (liens,
boutons, champs, `summary`, rôles `button` et `link`, `tabindex`). Le survol passe par la
souris de Playwright, le focus par la touche Tab, comme au clavier (`:focus-visible` compris) ;
le parcours au clavier s'arrête quand la page défile. Chaque état est capturé
(`animations="disabled"`) et comparé à l'élément au repos, découpé avec 4 px de marge : moins de
0,2 % de pixels changés, c'est « aucun style d'état ». Un focus sans style visible est aussi un
échec d'accessibilité (WCAG 2.4.7) ; un élément que Tab n'atteint pas est compté à part.

## La correction d'après les passes (`pass_fix.py`)

Demandée par la case « Corriger d'après les passes » (inactive sans passe), elle suit les passes,
une seule fois. Les constats qu'une correction peut traiter deviennent des phrases neutres : aux
largeurs non comparées à la maquette, débordement de la page, élément qui dépasse le bord, texte
coupé, chevauchement ; pour les états, survol sans style et focus sans style visible. Un élément
que Tab n'atteint pas n'est pas renvoyé (le parcours s'arrête quand la page défile, ce n'est pas
un constat sûr), ni la largeur comparée à la maquette, qui est le travail de la boucle. Le modèle
reçoit le rendu à la taille de la maquette et les rendus des largeurs en défaut côte à côte, le
prompt `design_to_code_pass_fix.md` (constats dans un bloc JSON qu'il dit être des données, comme
les libellés qu'ils citent, venus du code généré) et répond comme une correction.

La version corrigée est mesurée de nouveau : rendue à la taille de la maquette et comparée à
elle, puis repassée par les mêmes passes. Elle remplace la version gardée seulement si les passes
trouvent moins de problèmes et que le score n'a pas baissé de plus de `min_gain` ; sinon elle est
écartée (`regressed`, `no_gain`). Ses jetons entrent dans le budget de la boucle (`Spend`), et un
budget déjà épuisé l'empêche (`budget`). Le rapport `pass_fix` donne le statut, les constats
avant et après, les modifications appliquées ou refusées, le score et la dépense ; une
correction gardée remplace aussi le rapport des passes.

## Le suivi des écarts

Un écart est identifié par sa zone, son type et son axe. Il est `open` tant qu'il se mesure,
`resolved` quand il disparaît (avec l'itération), et `abandoned` s'il est encore là quand la
boucle s'arrête sans converger. Un écart résolu qui revient se rouvre.

## La page

`IterationPanel.tsx` s'affiche au-dessus des fichiers de l'étape « Code » : le statut et le
score retenu, une puce par itération (score, « générée », « retenue »), la cible, le rendu et
la carte de diff de l'itération choisie, le nombre de modifications appliquées, puis chaque
écart avec ce qu'il est devenu. Une boucle qui n'a pas tourné montre sa raison. Sous le statut, la
dépense (jetons, coût ou « coût inconnu » / « forfait ou modèle local ») ; un arrêt au budget
nomme le budget. Sous les écarts, les passes demandées : une carte par largeur avec son rendu et
ses constats, puis chaque élément interactif au repos, au survol et au focus. Pendant la boucle,
la vue en direct et le nœud « Code » donnent l'itération en cours, puis la passe en cours.

`LoopOptions.tsx`, dans la barre du bas quand la boucle est active, propose le nombre
d'itérations, le seuil et les deux budgets en listes de choix (`RENDER_LOOP_CHOICES`), les deux
passes et la correction d'après les passes. Sous la maquette, quand la boucle est active,
`MaskLayer.tsx` trace les zones exclues du score : « Masquer une zone », puis un glisser sur
l'image ; chaque zone a son bouton pour la retirer, et changer de maquette les efface. Sous les
passes, une ligne dit ce qu'est devenue la correction d'après elles. Aucun canal IPC nouveau : la requête porte `renderLoop`, que le main ne transmet que s'il
vaut strictement `true`, et `renderLoopOptions`, dont le main (`renderLoopArgs`) ne transmet
qu'un nombre fini dans ses bornes (`RENDER_LOOP_BOUNDS`, entier quand il le faut), un `true`
strict et les zones valides (au plus 12) ; le reste est laissé au défaut du runner, qui revérifie les bornes.

## Tests

`tests/design_to_code/` (diff sur des images dessinées, rendu avec un faux Playwright, boucle
avec un correcteur scripté, budget sur les formes de chaque provider, passes sur un faux
navigateur qui dessine survol et focus, correction d'après les passes avec chacune de ses
issues), `tests/services/test_design_to_code_render_loop.py`,
`tests/services/test_design_to_code_edit_calls.py` (sortie structurée sur un faux client du SDK),
`tests/services/test_design_to_code_vision_usage.py`, `tests/test_design_to_code_runner_cli.py` ;
côté app, `IterationPanel.test.tsx`, `LoopReport.test.tsx`, `LoopOptions.test.tsx`,
`MaskLayer.test.tsx`, `design-import.test.tsx`, `design-to-code-store.test.ts`,
`design-to-code-run.test.ts`.

## Pas encore fait (suite de #379)

- Rendre les vrais composants par la chaîne d'outils du projet (Storybook, Vite, App
  Emulator, snapshots par plateforme) au lieu du miroir HTML : il faut exécuter le JavaScript du
  code généré et lancer les outils du projet (installation, serveur de développement), donc
  lever la garde du rendu (JavaScript coupé, hors réseau) pour du code non fiable ; cela demande
  un lanceur isolé à concevoir, et App Emulator vit dans le main d'Electron, que le runner
  n'atteint pas.
- Diff sémantique (CLIP ou équivalent) : il faut des poids de modèle (plusieurs centaines de Mo)
  que l'app ne livre pas et qu'elle ne peut pas télécharger en hors-ligne strict, et aucun des
  providers de la page n'offre ici d'embeddings d'image (Gemini ne les donne que par Vertex AI,
  avec un compte Google Cloud).
- Réponse imposée (appel d'outil forcé) pour Claude par clé d'API, OpenAI, Gemini, LM Studio,
  llama.cpp et Ollama : les clients d'agent de `core.client` n'envoient qu'un prompt texte, sans
  image, et le chemin du SDK, seul à porter une image et un schéma de réponse, demande la
  connexion Claude Code, qu'une clé d'API seule ne donne pas. Ces routes gardent le JSON dans le
  texte des appels de vision du service ; il faut d'abord que `core` sache porter une image et
  un outil imposé pour ces providers.
- Vérifier le prompt sur au moins trois providers de vision réels : il faut leurs comptes
  payants ; les tests jouent leurs formats sur de faux serveurs et un faux client du SDK.
