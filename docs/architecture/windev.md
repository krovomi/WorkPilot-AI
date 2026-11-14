# WinDev, WebDev et WinDev Mobile

WorkPilot prend en charge les projets PC SOFT (WLangage) **dans la mesure où un agent peut les lire** :
un projet sauvegardé au format texte (option « Git », WinDev 25 et plus) se modifie dans son code ; un
projet au format natif ne se lit pas du tout, et WorkPilot le dit au lieu de produire du code inventé.

Code : `apps/backend/windev/` (une feuille, n'importe rien du backend), skills :
`skills/windev/` (`wlangage`, `windev-text-format`).

## Les deux formats

| Format | Reconnaissance (`windev.files.sniff_format`) | Ce qu'un agent lit |
|---|---|---|
| natif (défaut) | le fichier commence par `PCS`, le reste est compressé | rien |
| texte (option, v25+) | première ligne `#To edit and compare internal_properties, use WINDEV integrated tools.` | le code WLangage, les noms d'éléments et de champs |

Le format texte est un YAML : chaque traitement est un bloc `code : |1+` / `code : |1-` (indenté d'une
espace sous sa clé), suivi du `type` de l'événement ; tout ce que l'éditeur dessine (positions,
libellés, liaisons) est dans des clés `internal_properties` en base64 opaque, chaque élément porte un
`identifier`, chaque procédure un `procedure_id`. Même dans un projet texte, l'analyse (`.wda`,
`.wdd`), les requêtes (`.wdr`), les scénarios de test (`.wxt`), les styles et gabarits et les données
HFSQL (`.fic`, `.ndx`, `.mmo`) restent binaires. Constaté sur quatre projets publics enregistrés par
WinDev 25 à 28 ; le YAML écrit par l'éditeur n'est pas toujours valide (une ligne
`template_refs : []   -` dans une classe de WinDev 27), d'où un lecteur ligne à ligne
(`windev.text_format`) plutôt qu'un parseur YAML.

## Ce que WorkPilot en fait

| Morceau | Où | Rôle |
|---|---|---|
| Détection | `project/stack.py` (`windev_project`, langage `wlangage`, type `windev`) → `windev.project` | `.wdp` à la racine ou deux niveaux plus bas ; produits (`windev`, `webdev` si des pages `.wwh`, `windev-mobile` si une configuration Android ou iOS), version, nombre d'éléments texte et binaires |
| Consignes des agents | `prompts_pkg.prompts.platform_section` → `windev.prompt.windev_section` | planner, chaque sous-tâche du coder, revue QA, fixer et phases de skill : écrire seulement dans les blocs `code`, ne jamais toucher `internal_properties` / `identifier` / `procedure_id` ni un binaire, pas d'élément nouveau ; le planner range ce que seul l'éditeur sait faire dans des sous-tâches « À faire dans l'éditeur WinDev » |
| Skills | `windev.skills.stage_skills` | `wlangage` et `windev-text-format` copiées dans `<spec>/windev/`, lisibles par tous les providers, comme l'échelle .NET ([dotnet-upgrade.md](dotnet-upgrade.md)) |
| Contrôle d'intégrité | `windev.integrity.check_changes` | compare chaque fichier WinDev changé à sa version d'avant la tâche : binaire modifié, élément créé ou supprimé, en-tête ou bloc `info` changé, `internal_properties` ou `identifier` inventé ou disparu, `procedure_id` en double, fichier qui ne se lit plus en YAML alors qu'il se lisait. Chaque constat est un fait lu dans les deux versions, jamais une supposition |
| Sous-agents | `subagents/languages/windev.py` | le `test-runner` ne reçoit aucune commande : rien n'exécute les tests hors de l'éditeur |

## Ce qui n'est pas vérifiable ici

Rien ne compile du WLangage hors de l'éditeur WinDev (Windows, licence). La compilation et les tests
automatiques ne sont donc jamais déclarés « passés » : un projet qui veut les faire tourner déclare sa
propre commande dans la table `[proofs]` de `.workpilot/worktree.toml`, exécutée par la porte QA
`proof-checks` une fois la recette approuvée ([proof-checks.md](proof-checks.md)) ; sans elle,
le rapport dit « non vérifié ». La documentation de la génération en ligne de commande de PC SOFT
n'a pas pu être lue pendant la conception : aucune syntaxe n'est écrite en dur.
