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
| Porte QA | `qa/windev_gate.py`, dans la chaîne de `qa/loop.py` après `proof-checks` | une fois la QA approuvée, chaque fichier WinDev du lot de changements (lu par git comme pour la revue) est comparé à sa version de la base : un seul constat rejette la passe, le fixer reçoit un `QA_FIX_REQUEST.md` qui dit quoi remettre (`git checkout <base> -- <fichier>` pour un binaire), et `windev_integrity.json` garde le relevé. Un lot que git n'a pas pu lire est noté non vérifié, jamais réussi |
| Couverture | `qa/loop.py` (`_coverage_gate`, `windev_only`) | non applicable quand tout le code changé est du WinDev : les scénarios de test ne tournent que dans l'éditeur, aucun chiffre ne peut exister, et l'exiger enverrait le fixer inventer des tests. Un lot mixte (WinDev et un service C#) garde la porte |
| Encart « Plateformes mobiles » | `mobile.bootstrap.mobile_profile` → `windev.project.WinDevProject.mobile_platforms` | un projet WinDev Mobile montre ses plateformes (lues dans les configurations de génération) et dit que l'application se génère dans l'éditeur ; un projet WinDev sans configuration mobile ne se voit proposer aucune tâche d'installation (Flutter, MAUI…) |
| Sous-agents | `subagents/languages/windev.py` | le `test-runner` ne reçoit aucune commande : rien n'exécute les tests hors de l'éditeur |

## Les features annexes

| Feature | Ce qu'elle fait d'un projet WinDev | Pourquoi |
|---|---|---|
| Traduction inter-langages | WLangage est une langue **source** seulement (`wlangage` dans `cross_language_translation_runner.py` et la liste du main) : un élément au format texte collé ou ouvert est réduit à son code (`windev.text_format.wlangage_source`, un commentaire par propriétaire et événement), sans le YAML ni le base64 de l'éditeur | une traduction vers WLangage n'aurait aucun élément où aller : seul l'éditeur en crée un. C'est le chemin d'une migration WinDev → .NET, TypeScript… |
| Studio de tests | refus explicite (`unsupported_stack`) pour une source WinDev, ou un projet WinDev sans source ni langage choisi | un test WinDev est un scénario `.wxt`, binaire, que seul l'éditeur crée et exécute ; avant, le studio retombait sur Python et écrivait un fichier pytest |
| Détective de tests instables | aucune commande de test détectée, il le dit (`no_command`) | rien n'exécute les tests hors de l'éditeur |
| Import Design, Visuel vers Code, licences, i18n | rien de propre à WinDev | les fenêtres et leurs libellés sont dans `internal_properties`, opaques ; WinDev n'a pas de gestionnaire de paquets |

## Ce qui n'est pas vérifiable ici

Rien ne compile du WLangage hors de l'éditeur WinDev (Windows, licence). La compilation et les tests
automatiques ne sont donc jamais déclarés « passés » : un projet qui veut les faire tourner déclare sa
propre commande dans la table `[proofs]` de `.workpilot/worktree.toml`, exécutée par la porte QA
`proof-checks` une fois la recette approuvée ([proof-checks.md](proof-checks.md)) ; sans elle,
le rapport dit « non vérifié ». La documentation de la génération en ligne de commande de PC SOFT
n'a pas pu être lue pendant la conception : aucune syntaxe n'est écrite en dur.
