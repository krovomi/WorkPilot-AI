---
feature: REA
summary: >-
  Lecteurs statiques de npm `rea-agents` (figé dans `rea/pin.json`) : fuses et audit des apps
  livrées, badge « Outils CLI », portes QA `artifact-exposure`, `public-api-stable` (.NET), étape
  du Release Train ; inconnu jamais vert ; jamais en MCP par défaut, jamais la cible exécutée.
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

## Lot B : la porte « Exposition de l'artefact »

Ce que livre une tâche, et pas seulement WorkPilot : après l'approbation du relecteur, avec les
autres portes qui peuvent la renverser (`qa/loop.py`), `qa/exposure_gate.py` lit par
`audit-release-exposure` la sortie de build que la tâche a laissée dans son worktree. La porte ne
construit jamais (un build lance le code du projet) : un worktree de tâche part sans sortie de
build, donc ce qu'elle trouve vient de la tâche.

- **Toutes les stacks** (`rea/artifacts.py`), par nom, dans une table fermée des dossiers de sortie
  de chaque stack et sous un parcours borné (profondeur 8, 50 000 entrées, 6 artefacts) qui
  saute dépendances et caches : bundle Electron ou Tauri (`*-unpacked/`, `.app`, `.AppImage`,
  `.dmg`, `.msi`, `.deb`, `.rpm`, `.exe` d'un dossier de release), Android et iOS (`.apk`,
  `.aab`, `.ipa`), build web contenant du JavaScript (`dist/`, `build/`, `out/`, `.next/`,
  `.output/`, `wwwroot/_framework` de Blazor), dossier `publish/` de .NET, `.jar` / `.war` de
  `target/` ou `build/libs/`, exécutables de `target/release/` de Rust (un `.exe` seulement sous
  Windows, où tout fichier se dit exécutable), `.whl` de `dist/`, `.nupkg`, `.vsix`, `.wasm`. Aucun
  lien symbolique n'est suivi ; tout chemin est résolu et gardé seulement dans le projet.
- **Le verdict vient des checks** (`rea/exposure.py`) : un check `exposed` au seuil ou au-dessus
  (`high` par défaut) échoue ; `unknown` et `not_assessed`, ce que l'analyse statique n'a pas pu
  trancher, ne bloquent jamais. Pas de sortie de build, pas de Node.js, REA absent, un délai
  dépassé, un artefact que REA n'a pas pu lire : `unchecked`, lu comme inconnu, jamais comme un
  succès.
- **Mode** : `WORKPILOT_QA_ARTIFACT_EXPOSURE`. `warn` (défaut) ne bloque pas et n'utilise que REA
  déjà installé à la version figée : la QA ne télécharge pas un outil d'elle-même. `strict` renvoie
  au fixer un `QA_FIX_REQUEST.md` avec les remédiations de REA, citées comme sortie d'outil non
  fiable (`quote_untrusted`), et peut récupérer la release figée par npx, sauf en hors-ligne strict
  (une politique illisible compte comme hors-ligne). `off` l'arrête. Le seuil :
  `WORKPILOT_QA_ARTIFACT_EXPOSURE_FAIL_ON`. Une valeur inconnue revient au défaut : une faute de
  frappe ne doit ni bloquer ni éteindre la porte.
- **La porte dure `artifact-exposure`** (`workflows/hard_gates.py`) lit `artifact_exposure.json`
  dans le dossier de la spec ; un workflow qui la déclare rend la porte QA `strict`.
- **Mode serveur** : la porte fait partie de la boucle QA, donc d'un run du serveur, confiné à son
  clone comme le reste. REA n'y tourne jamais par son serveur MCP HTTP.
- **Release Train** (`release_coordinator`) : une étape `exposure: {artifact, fail_on, timeout}`
  par service, avant `deploy` (voir [release-train.md](release-train.md)). Un artefact absent ou
  hors du projet, ou REA qui ne peut pas tourner, est une erreur qui arrête le train : une
  vérification déclarée qui n'a pas pu tourner n'est pas un succès. Un service arrêté là n'a rien
  déployé, donc un retour arrière ne lance pas sa commande de rollback.

## Lot D : l'API publique des bibliothèques .NET

Migrer une bibliothèque de .NET 9 à .NET 10 ne doit pas changer ce que ses consommateurs appellent.
Rien ne le vérifiait : le build et les tests du projet passent même quand un membre public a
disparu. `qa/dotnet_api_gate.py` le vérifie après l'approbation du relecteur, avec les autres
portes (`qa/loop.py`).

- **Quels projets** (`rea/dotnet_api.py`) : une tâche dont le diff touche du .NET (`.cs`, `.fs`,
  `.vb`, un `.csproj` / `.fsproj` / `.vbproj`, un `.props` ou `.targets`, `global.json`). Chaque
  fichier appartient au projet du dossier le plus proche qui en contient un ; un fichier que
  tous les projets importent (`Directory.Build.*`, `global.json`, un `.props`) les touche tous.
  Jamais un projet de test, au plus 8 projets : au-delà, le verdict est inconnu.
- **Deux builds, jamais dans le worktree** : chaque projet est construit (`dotnet build -c
  Release`) au commit de base de la tâche puis tel que la QA l'a relu, chacun dans une copie
  jetable (`mutation_gate.sandbox.scratch_copy`, avec `revision=` pour la base). L'assembly vient
  du `TargetPath` de MSBuild pour chaque framework cible, donc un `OutputPath` personnalisé ou la
  disposition `artifacts/` se trouvent sans deviner ; un exécutable ou un projet de test
  (`IsTestProject`) n'est pas une bibliothèque. Le build lance le MSBuild du projet, comme le
  `dotnet build` du relecteur, avec l'environnement du backend sans ses identifiants. Les
  assemblies de la base sont gardées sous `<spec_dir>/dotnet-api/base/<sha>/` : une seconde passe
  de QA ne reconstruit que la tâche.
- **Les frameworks** : ceux que les deux côtés construisent, sinon le plus récent de chaque côté,
  ce que fait une migration (`net9.0` → `net10.0`). Un framework abandonné est noté, pas bloquant.
- **Le verdict vient de REA** (`rea/managed_api.py`) : `inspect-managed-members` de chaque côté
  donne la visibilité (masque d'accès ECMA-335 des membres, et des types le long de leur
  imbrication), `compare-managed-members` apparie les membres par type, nom, signature et IL. Un
  membre public retiré, rendu invisible, renommé ou dont la signature change casse ; un ajout, un
  corps changé, tout ce qui n'est pas public, non. Une lecture partielle de REA (capacité,
  métadonnées malformées), un membre public qu'il n'a pas pu apparier, un build qui échoue, pas de
  SDK : inconnu, jamais un succès, jamais un blocage.
- **Mode** : `WORKPILOT_QA_DOTNET_API`. `warn` (défaut) ne bloque pas, et sans REA déjà installé à
  la version figée rien n'est construit. `strict` renvoie au fixer les membres cassés, cités comme
  sortie d'outil non fiable ; une migration que la préparation a posée (`dotnet_upgrade`, modes
  `migrate` et `chain`) ou un workflow qui déclare la porte dure `public-api-stable` le rendent
  `strict`. Délai de chaque commande : `WORKPILOT_QA_DOTNET_API_TIMEOUT`. La section de migration
  du prompt dit au planner, au codeur et à la QA que l'API est comparée ; une rupture que la
  nouvelle version impose est remontée à une personne, jamais cachée.
- **La porte dure `public-api-stable`** lit `dotnet_public_api.json` : tenue quand rien de .NET n'a
  changé ou que l'API est gardée.

## Lot E : les serveurs MCP du projet pour les providers en CLI

Un serveur MCP installé dans le projet n'atteignait que le SDK Claude et la boucle WorkPilot :
Codex, OpenCode et les agents ACP recevaient `mcpServers: []`, Copilot n'avait pas de pont. Le
lot les branche tous, puis ajoute REA au catalogue, en option.

- **À la même condition que le SDK** (`core/cli_mcp.py`). Un CLI ouvre le serveur lui-même et
  montre au modèle tout ce qu'il liste, comme Claude Code : il ne reçoit donc que les serveurs que
  `load_mcp_server_configs_for` garde pour le type d'agent (validés, ajoutés à cet agent), et
  parmi eux ceux dont chaque outil listé est celui que la personne a approuvé
  ([mcp-pins.md](mcp-pins.md)). Un serveur jamais approuvé, modifié ou injoignable ne démarre pas.
- **Dans les mots de chaque CLI**, jamais par un shell :
  - Codex : des surcharges `-c mcp_servers.<id>.…`. L'environnement du serveur et ses en-têtes HTTP
    passent par l'environnement du processus Codex, nommés par `env_vars` et `env_http_headers` :
    aucun secret sur la ligne de commande. Une valeur hors d'un jeu de caractères simple (espace,
    guillemet, `&`, `%`) pourrait changer ce que `cmd.exe` lance pour un lanceur npm `.cmd` : ce
    serveur est écarté, et le journal le dit. Un serveur qui remplacerait une variable de Codex
    (`OPENAI_API_KEY`, `PATH`) l'est aussi.
  - OpenCode : le bloc `mcp` de `OPENCODE_CONFIG_CONTENT`, la configuration en ligne qu'OpenCode
    charge en dernier, fusionnée avec celle qui y serait déjà.
  - ACP (Gemini CLI…) : `mcpServers` de `session/new` ; un serveur HTTP seulement à un agent qui
    déclare `mcpCapabilities.http`.
  - Sous le bac à sable de l'OS, un serveur HTTP est écarté : le processus n'atteint que les hôtes
    de son provider et les registres. Un serveur en commande tourne dans le bac à sable avec le CLI.
- **Copilot** passe par le pont de la boucle WorkPilot (`core/agent_clients/mcp_bridge.py`, le
  même qu'OpenAI) : seuls les outils approuvés sont offerts. pi n'a pas de client MCP.
- **`providers.yaml`** : `standards.mcp` gagne la valeur `handed` (OpenCode, Gemini CLI) et Copilot
  passe à `bridged` ; `tests/test_provider_standards.py` vérifie chaque affirmation contre le client.
- **REA au catalogue MCP**, en option : `npx -y rea-agents@6.9.0 mcp`, la version figée, avec
  `REA_MCP_INPUT_SCHEMA_PROFILE=compact`, `REA_MCP_OUTPUT_SCHEMA_PROFILE=compact` et
  `REA_MCP_TOOL_CATALOG_PROFILE=hot-cold` : cinq outils au démarrage au lieu de 240. Il n'est
  proposé qu'à l'`analyzer`, l'agent des tâches d'enquête (champ `agents` de l'entrée), et
  `REA_MCP_TOOL_FAMILIES` laisse dehors les familles qui pilotent un appareil, un navigateur ou un
  programme en marche (`frida`, `adb`, `browser`, `javascript-runtime`, `application`). Limite :
  l'épinglage porte sur les outils listés au démarrage ; ceux que `discover_tools` charge pendant
  la session viennent de ces familles statiques, mais aucune empreinte ne les a vus.
