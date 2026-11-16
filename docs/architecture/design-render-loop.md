---
feature: Import Design, boucle de rendu et d'auto-correction
summary: >-
  Après la génération, Import Design rend le code dans un Chromium sans JavaScript ni réseau,
  le compare à la maquette (pixels avec tolérance et SSIM, par zone) et demande au modèle de
  vision du provider choisi des corrections ciblées, jusqu'au seuil ou au budget. La meilleure
  version est livrée, avec la liste des écarts restants.
---

# Import Design : la boucle de rendu et d'auto-correction

Issue #379, premier lot. Le code généré depuis une maquette n'était jamais regardé : rien ne
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
apps/backend/services/design_to_code_render_loop.py   le raccord au service d'Import Design
apps/backend/prompts/design_to_code_iteration.md      le prompt de correction
apps/frontend/.../design-import/IterationPanel.tsx    le panneau des itérations
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
corrections par défaut), `budget` (600 s par défaut, vérifié avant chaque correction),
`stalled` (aucun gain de `min_gain` pendant `patience` corrections), `failed` (capture ou appel
au modèle en échec : la meilleure version déjà obtenue reste). Le runner borne ses options :
1 à 10 itérations, seuil de 0,5 à 0,999, budget de 30 à 3 600 s.

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
  vidéo…) sont exclus de la mesure ; le panneau les nomme.
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
illisible ne change rien. Rechercher-remplacer plutôt que fichiers entiers : les appels de
vision du service plafonnent leur réponse, un fichier complet y serait tronqué.

La route suit le provider choisi pour la page, sans jamais en prendre un autre : Claude (clé ou
abonnement), OpenAI (et Copilot), Google, Ollama. Une clé absente, un provider sans route de
vision, ou un modèle que le registre marque texte seul (`supports_vision=False`,
`models_registry.vision_support`) est un refus avec sa raison, que la page traduit. En hors-ligne
strict (`offline_policy.airgap_status`), la seule route est un modèle de vision local par
Ollama, en boucle locale (`docintel.engines.ollama_vision`) : aucune image ne quitte la machine.
Une erreur du provider remonte comme « provider answered HTTP 500 », jamais avec le texte reçu.

## Le suivi des écarts

Un écart est identifié par sa zone, son type et son axe. Il est `open` tant qu'il se mesure,
`resolved` quand il disparaît (avec l'itération), et `abandoned` s'il est encore là quand la
boucle s'arrête sans converger. Un écart résolu qui revient se rouvre.

## La page

`IterationPanel.tsx` s'affiche au-dessus des fichiers de l'étape « Code » : le statut et le
score retenu, une puce par itération (score, « générée », « retenue »), la cible, le rendu et
la carte de diff de l'itération choisie, le nombre de modifications appliquées, puis chaque
écart avec ce qu'il est devenu. Une boucle qui n'a pas tourné montre sa raison. Pendant la
boucle, la vue en direct et le nœud « Code » donnent l'itération en cours. Aucun canal IPC
nouveau : la requête porte un booléen `renderLoop`, que le main ne transmet que s'il vaut
strictement `true`.

## Tests

`tests/design_to_code/` (diff sur des images dessinées, rendu avec un faux Playwright, boucle
avec un correcteur scripté), `tests/services/test_design_to_code_render_loop.py`,
`tests/test_design_to_code_runner_cli.py` ; côté app, `IterationPanel.test.tsx`,
`design-import.test.tsx`, `design-to-code-store.test.ts`, `design-to-code-run.test.ts`.

## Pas encore fait (lot 2 de #379)

- Rendre les vrais composants par la chaîne d'outils du projet (Storybook, Vite, App
  Emulator, snapshots par plateforme) au lieu du miroir HTML.
- Passe responsive sur trois points de rupture.
- Diff sémantique (CLIP ou équivalent) en plus du diff de pixels.
- Captures multi-états (survol, focus).
- Dessiner des masques dans la page.
- Budget en jetons et en coût, en plus du temps et des itérations.
- Réponse imposée par tool use plutôt que JSON dans le texte.
- Choisir le nombre d'itérations et le seuil dans la page.
- Vision locale pour LM Studio et llama.cpp.
