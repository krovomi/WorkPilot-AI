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
