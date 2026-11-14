---
feature: REA
summary: >-
  Lecteurs statiques de npm `rea-agents` (figé dans `rea/pin.json`) : fuses et audit des apps
  livrées, badge « Outils CLI » ; jamais en MCP par défaut, jamais la cible exécutée.
---

# REA : ce que révèle un logiciel livré

[REA](https://github.com/morluto/rea) (« Reverse Engineer Anything », npm `rea-agents`, MIT) lit un
logiciel sans son code source : un exécutable, un ASAR Electron, un bundle JavaScript, un assembly
.NET, un APK. WorkPilot ne s'en sert que pour ce qui lui manquait : regarder **ce que le projet
livre**, et non plus seulement ses sources et ses manifestes. Évaluation complète et lots : thread
« Évaluer l'intégration de REA » du 14 novembre 2026.

## Une seule version, figée

`apps/backend/rea/pin.json` nomme la release de REA que WorkPilot lance, et les versions de Node.js
qu'elle accepte (son champ `engines`). Jamais `@latest` : REA a publié 40 versions entre juillet et
novembre 2026 et son catalogue d'outils change d'une semaine à l'autre. Une montée de version est
une PR qui change ce fichier ; `tests/test_release_exposure_audit.py` refuse une plage.

## Ce que WorkPilot n'en fait pas

- **Pas de serveur MCP par défaut dans les phases du Kanban.** REA expose 240 outils, soit 68k à
  120k tokens de définitions par requête quand le client ne diffère pas les outils (leur propre
  mesure), et chaque outil ajouté remettrait le serveur en attente d'approbation
  ([mcp-pins.md](mcp-pins.md)).
- **Pas de commande qui exécute la cible** (capture runtime, navigateur, adb) : seulement les
  lectures statiques, qui ne lancent ni l'application ni le réseau.
- **Pas de HTTP MCP de REA en mode serveur** : il n'a ni TLS ni authentification.
- **Pas de « reconstruire la fonctionnalité d'une autre application »** : l'usage visé est le
  logiciel de l'utilisateur et ce qu'il a le droit d'analyser.

## Lot C : nos propres releases

L'app packagée n'avait aucun fuse Electron : `ELECTRON_RUN_AS_NODE=1` faisait de l'exécutable
signé un Node.js ordinaire, `--inspect` y ouvrait un débogueur, et le code pouvait se charger d'un
dossier `app/` posé à côté de `app.asar`. electron-builder bascule désormais les fuses pendant le
packaging (`build.electronFuses` de `apps/frontend/package.json`) :

| Fuse | Valeur | Ce que REA vérifie |
|---|---|---|
| `runAsNode` | `false` | `electron.run_as_node` (haute) |
| `enableNodeCliInspectArguments` | `false` | `electron.node_cli_inspect` |
| `onlyLoadAppFromAsar` | `true` | `electron.only_load_from_asar` |
| `enableEmbeddedAsarIntegrityValidation` | `true` | `electron.asar_integrity` (macOS et Windows ; reste `unknown` sur un ELF) |

Les autres restent à leur valeur d'Electron. `grantFileProtocolExtraPrivileges` en particulier :
la fenêtre se charge par `loadFile` (`file://`). `enableNodeOptionsEnvironmentVariable` aussi :
`NODE_EXTRA_CA_CERTS`, qu'il coupe en même temps que `NODE_OPTIONS`, sert derrière un proxy
d'entreprise. Rien dans le main ne lance l'exécutable en Node (`process.fork`,
`ELECTRON_RUN_AS_NODE`) : couper `runAsNode` ne casse aucun chemin.

Les source maps des dépendances ne partent plus dans `app.asar` (`!**/node_modules/**/*.map` dans
`build.files`) : REA en a trouvé 32 (`javascript.source_maps`, moyenne), sans les sources mais
inutiles à l'exécution.

`apps/frontend/scripts/release-exposure-audit.cjs --packaged --fail-on high` audite ensuite l'app
que electron-builder a laissée dans `dist/`, après le smoke test de chaque job de `release.yml`,
en deux passes :

- **le dossier d'installation** (`linux-unpacked`, `win-unpacked`, `mac*/WorkPilot AI.app`) : le
  JavaScript, les source maps, les fichiers de débogage, le texte livrés ;
- **le binaire qui porte les fuses** (l'exécutable, `Electron Framework` sur macOS) : REA ne passe
  que quatre images natives d'un dossier à son lecteur de fuses, et sur Linux l'exécutable de l'app
  n'en faisait pas partie, si bien que les quatre contrôles Electron restaient `unknown`.

Vérifié le 14 novembre 2026 sur l'app Linux packagée : avec les fuses d'Electron par défaut,
l'exécutable sort `electron.run_as_node` exposé (haute), `only_load_from_asar` et
`node_cli_inspect` exposés (moyenne), et REA sort en code 3 ; avec `build.electronFuses`, les
trois passent à `not_observed`. Le dossier ne garde que `packaging.extractable_payload` (basse,
inhérent à un ASAR) et `native.pdb_path` (basse, chemins de build des binaires précompilés de
better-sqlite3).

Le reste du script :

- npx tourne depuis un dossier temporaire à lui (aucun `.npmrc` ni `node_modules` du dépôt ne
  choisit ce qui s'exécute), sans shell, avec le Node.js du job, vérifié contre `pin.json` ;
- chaque rapport va dans `dist/release-exposure/<plateforme>-<arch>-<install|executable>.json`,
  téléversé même en cas d'échec (artefact `release-exposure-<plateforme>`, hors des fichiers de la
  release), et son tableau dans le résumé du job ;
- le job échoue sur un contrôle `exposed` de sévérité haute (source maps avec leurs sources,
  `RunAsNode`, marqueur d'identifiant) ou si l'audit n'a pas pu finir. `unknown` et
  `not_assessed` ne font jamais échouer : c'est ce que l'analyse statique n'a pas pu trancher, pas
  un constat.

## Lot A : le runner du backend et le badge « Outils CLI »

`apps/backend/rea/` est le seul chemin du backend vers REA, et seulement par sa CLI :

- `pin.py` lit `pin.json` et refuse une plage ou `latest` ;
- `locate.py` trouve un Node.js que la release accepte (sinon `node_missing` / `node_too_old`, jamais
  contourné), puis REA **installé à la version figée** (le `rea` du PATH résolu jusqu'à
  `rea-agents/scripts/rea.mjs`, lien npm sous macOS et Linux, `rea.cmd` voisin de
  `node_modules/` sous Windows, et son `package.json` lu), sinon `npx-cli.js` à côté de Node.js
  pour la récupérer. npx est un téléchargement : un projet en hors-ligne strict (`airgapStrict`)
  le refuse (`offline`). Les deux se lancent en `[node, <script>, …]`, sans shell ni `.cmd` ;
- `runner.py` (`run_rea`) ne lance qu'une commande de `COMMANDS`, des lecteurs statiques
  (`audit-release-exposure`, `inspect-electron-fuses`, `inspect-binary-hardening`,
  `inspect-managed-members`, `compare-managed-members`), sur des chemins absolus qui existent
  (résolus, donc jamais lus comme une option), avec des options en liste fermée, depuis un dossier
  temporaire à lui, avec l'environnement du backend sans ses identifiants
  (`security.child_env`). Sa réponse est `ReaRun` : `result` est le `normalized_result` de REA,
  une donnée, à citer comme non fiable avant qu'un modèle la lise. La sortie 3 (`--fail_on`
  atteint) est une réponse, pas un échec.

Le badge REA du panneau « Outils CLI » (`ReaStatusBadge`, `main/ipc-handlers/rea-handlers.ts`) dit
si le `rea` du PATH mène à la version figée, par la même lecture du `package.json` (jamais en
lançant `rea`), et installe exactement cette version : `npm install -g --ignore-scripts
rea-agents@<pin>`, réessayé dans `~/.local` si le préfixe global n'est pas inscriptible. Une autre
version installée compte comme présente mais n'est pas lancée : le badge propose la version figée
à sa place, et il n'y a pas de mise à jour vers `@latest`. Les deux canaux ne prennent aucun
argument. `REA_PIN` (`shared/types/rea.ts`) est la copie de `pin.json` que le renderer importe ;
`tests/rea/test_rea_frontend_pin.py` les garde égaux.
