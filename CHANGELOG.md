# Changelog

All notable changes to WorkPilot AI are documented here. This is the only
changelog: `scripts/bump-version.js` and the release workflow read it. The
complete 1.0.0 notes and the upstream 2.x history lived in a second file,
`docs/CHANGELOG.md`, removed in audit lot L9; it remains in the git history
([last version](https://github.com/krovomi/WorkPilot-AI/blob/f385fe1/docs/CHANGELOG.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 🧹 Maintenance

- **Le marqueur `RESUME_WITH_PROVIDER` n'est plus lu** (F25 de l'audit). Plus rien ne
  l'écrit depuis #290 : reprendre une tâche avec un autre provider verrouille le moteur
  de la tâche dans `task_metadata.json`. La lecture gardée une version pour les tâches
  mises en pause sous 1.2.1 est retirée, et la résolution du provider n'a plus d'effet
  de bord.
- **L'annonce Discord ne laisse plus de run rouge** (F118). Sans le secret
  `DISCORD_WEBHOOK_URL`, le workflow dit que la release n'est pas annoncée et se
  termine vert.

---

## 1.3.3 - La reconnexion Claude tient sous Linux et WSL

Correctif de la 1.3.2 : après un `/login` réussi sous Linux ou WSL, l'application
retombait aussitôt en « reconnexion requise ». Le wiki suit aussi chaque release
sans intervention.

### 🐛 Corrections

- **Boucle de reconnexion Claude sous Linux et WSL** (#543). WorkPilot range les
  jetons qu'il rafraîchit dans Secret Service, alors que la CLI Claude n'écrit que
  `.credentials.json`. Secret Service était lu en premier : après un nouveau
  `claude /login`, l'application gardait l'ancienne copie et son refresh token
  expiré, d'où un `invalid_grant` juste après chaque reconnexion. Les deux
  magasins sont désormais comparés et le jeton qui expire le plus tard l'emporte
  (`pickFresherCredentials`), pour les lectures complètes comme courtes (F116 de
  l'audit). Le bouton Reconnecter de la notification ouvre Réglages > Comptes et
  lance directement la connexion du provider.

### ✨ Nouveautés

- **Le wiki suit chaque release sans push à la main.** Les pages écrites à la
  main (nouveautés, feuille de route, sécurité) vivent comme patchs
  `git format-patch` dans `scripts/wiki/patches/`, relus en PR ; la synchro
  `full` que lance chaque release les applique au wiki avant de rafraîchir ses
  blocs `AUTOGEN`. Un patch déjà présent est sauté, un patch qui ne s'applique
  plus est nommé et fait échouer le job sans bloquer les autres (F115 de
  l'audit). Le contenu 1.3.1 du wiki passe par ce chemin.

---

## 1.3.2 - L'application démarre de nouveau

Correctif de la 1.3.1, dont le process principal d'Electron s'arrêtait au
chargement, et une reconnexion Claude qui atteint enfin le profil concerné.

### 🐛 Corrections

- **Le process principal plantait au démarrage** avec `SyntaxError: Identifier
  '__filename' has already been declared` (#536). electron-vite 6 ajoute en tête
  du bundle ESM ses propres `const __filename`, `const __dirname` et
  `const require` ; 24 modules de `src/main` déclaraient aussi les leurs, et l'un
  d'eux gardait son nom dans `out/main/index.js`. Le code du main lit désormais
  `import.meta.dirname` / `import.meta.filename` et ne déclare plus ces noms ;
  `esm-dirname.test.ts` le garde (F114 de l'audit).
- **La reconnexion Claude met à jour le bon profil** (#537). Un `claude /login`
  lancé dans un terminal écrit dans `~/.claude`, alors qu'un profil WorkPilot lit
  son propre `CLAUDE_CONFIG_DIR` : il gardait son jeton expiré et restait en
  « reconnexion requise ». Le bouton Reconnecter ouvre maintenant la connexion
  dans le terminal intégré, réglé sur le profil ; le drapeau de reconnexion
  tombe dès qu'un jeton valide est lu, et sur `invalid_grant` un login récent
  trouvé dans `~/.claude` est signalé, sans copier de jeton d'un dossier à
  l'autre.
- **La boucle de vérification relance proprement son aide UI Automation.**
  Après une requête restée sans réponse, l'aide tuée signalait sa fin dans la
  file de la suivante, qui passait pour « arrêtée » dès son démarrage ; chaque
  aide lit désormais dans sa propre file.

---

## 1.3.1 - La carte va jusqu'au bout, et l'effort annoncé est celui reçu

Onze features issues de la veille du 26 octobre (annexe G de
[`docs/audit/AUDIT-NETTOYAGE.md`](docs/audit/AUDIT-NETTOYAGE.md)), l'effort de
raisonnement enfin envoyé tel qu'il est affiché, et les lots M1 à M11 de l'audit
du 17 octobre : moins de surface d'attaque côté renderer, une CI qui garde ce qui
est livré, et les quatre fonctions géantes du backend découpées.

### ⚠️ Changement incompatible

- **Le démon « Continuous AI » est retiré** (#519). Son runner, ses canaux IPC,
  son store et ses réglages disparaissent ; ce qu'il faisait seul, hors de toute
  carte, passe par les **automatisations** ci-dessous, qui créent une carte que
  la personne voit.

### ✨ Nouveautés

- **La carte suit sa PR jusqu'au merge** (#514). Un check rouge (avec son
  journal) ou un fil de revue non résolu part au QA fixer, dans le worktree de
  la tâche, avec son provider, son modèle et son effort ; le commit est vérifié
  puis poussé, jamais en force. Aucun faux vert : une forge illisible est
  « inconnue », l'absence de check n'est pas un succès, un commit qui saute,
  supprime ou désactive un test est annulé. Le merge reste à une personne.
- **Mode objectif** (#515). Une carte peut porter une définition de « fini »
  exécutable : une commande, le code de sortie attendu, un plafond de passes et
  de dépense. Le QA continue tant que la commande échoue ; les tests et le
  script de la commande sont protégés, et le fichier d'objectif n'est
  inscriptible par aucun agent.
- **« Besoin de toi »** (#516). Une tâche qui attend (plan, revue, passage QA,
  erreur) le dit sur le bureau, et sur ntfy ou Telegram si on le veut. Un plan
  en attente s'approuve depuis Telegram par un bouton à usage unique, qui
  expire et qui est vérifié contre le chat configuré et l'état de la tâche. Un
  plan en attente de revue n'est plus annoncé comme un échec.
- **Traces OpenTelemetry GenAI pour tous les providers** (#517). Avec un
  endpoint OTLP, chaque provider émet les mêmes spans (`invoke_agent`, `chat`,
  `execute_tool`) avec les attributs `gen_ai.*`, sans prompt, sortie ni entrée
  d'outil. Un usage non rapporté est absent, pas nul.
- **Best-of-N** (#518). Une tâche construite 2 à 4 fois, chacune dans son
  worktree avec son provider, son modèle et son effort ; la carte classe les
  builds sur des chiffres (build terminé, QA, objectif, taille du diff, coût) et
  la personne garde celui qu'elle choisit.
- **Automatisations** (#519). Une règle (issue étiquetée, CI rouge sur une
  branche, horaire) crée une carte brouillon, une seule par issue ou par série
  rouge, sous un plafond quotidien. Une source illisible est nommée, jamais lue
  comme « rien de neuf ».
- **Agents ACP, Gemini CLI d'abord** (#522). Un client Agent Client Protocol
  pour tout agent déclaré par un bloc `acp:` de `capabilities/providers.yaml`.
  Les droits sont tenus trois fois (mode de session, demandes de permission,
  arrêt sur outil non déclaré) ; une question de l'agent apparaît sur la carte
  avec ses options. L'agent démarre dans le bac à sable de l'OS.
- **Bac à sable de l'OS** (#523). Les commandes de la boucle WorkPilot et des
  CLI OpenCode, pi et Gemini tournent sous bubblewrap (Linux) ou Seatbelt
  (macOS) : écritures confinées au worktree, identifiants cachés, réseau limité
  aux hôtes du provider et aux registres de paquets par un proxy filtrant qui
  nomme ce qu'il refuse. Sans bac à sable (Windows, Ubuntu sous AppArmor
  restrictif), la carte le dit au lancement ; `WORKPILOT_SANDBOX=required`
  refuse alors de démarrer.
- **MCP 2026-07-28 : tasks et MCP Apps** (#524). Les serveurs MCP de WorkPilot
  répondent aux deux générations du protocole ; les longs `verify_*` reviennent
  en tâches à un client qui déclare l'extension Tasks. Les vues qu'un outil
  attache s'affichent dans le panneau de la tâche, dans une iframe isolée
  derrière un pont qui refuse tout appel.
- **Banc de rejeu sur le dépôt** (#525). 10 à 20 cartes terminées sont
  reconstruites depuis le commit qui les précède, par chaque moteur choisi,
  dans une copie isolée, et jugées par les tests du commit d'arrivée, que
  l'agent ne voit jamais. Le tableau nourrit Formula Lab et laisse le routeur
  écarter un modèle que le banc a vu échouer sur au moins trois cartes.
- **Vérifier une application Windows par UI Automation** (#526). Une app WPF,
  WinForms ou WinUI non empaquetée est lancée et conduite par l'arbre
  d'accessibilité, jamais par une frappe simulée, dans la seule fenêtre que la
  carte nomme, cherchée dans l'arbre de processus lancé et épinglée par son
  handle.

### 🐛 Corrections

- **L'effort annoncé est celui que le modèle reçoit** (#513, lot M11). Grok,
  DeepSeek et Mistral reçoivent `reasoning_effort` sur les modèles qui le
  prennent ; OpenAI « none » et Gemini 2.5 Flash reçoivent vraiment « none » ;
  Ollama reçoit `think` quand le modèle le déclare ; un refus 400 de l'effort
  relance le tour une fois sans lui, et le fil de la tâche le dit. Le
  sélecteur d'effort affiche ce qui est réellement envoyé
  (`GET /providers/effort`).
- **Une app Windows lancée par la vérification ne meurt plus au démarrage**
  (#527). Sous Windows, `os.kill(pid, 0)` envoie Ctrl+C au groupe de processus
  au lieu de sonder le pid ; `foundation.platform.pid_is_running` interroge le
  processus sans le signaler. Un projet .NET dans un sous-dossier est lancé
  depuis le bon dossier.
- Des features qui ne disent que ce qu'elles ont fait (lot M3) : pas de PR
  Azure DevOps inventée en cas d'échec, une suite .NET rouge arrive au relecteur
  QA au lieu de « exécuté avec succès ».
- Les événements du Live Companion et de Context Mesh sont enfin écoutés, et
  les modales de limite de débit et d'échec d'authentification s'affichent
  (lots M7 et M8).

### 🔒 Sécurité

- **Aucune ligne de commande construite depuis le renderer ou un texte
  externe** (lot M1) : release GitHub sans shell, ouverture dans l'IDE ou le
  terminal liée à un projet connu, script Azure DevOps statique. L'app Windows
  empaquetée tourne en `asInvoker`.
- **Aucun identifiant stocké ne rejoint le renderer** (M5) : clés d'API, jetons
  OAuth et clés de provider sont masqués ; les tests de connexion tournent dans
  le main. Les journaux des runners sont expurgés, aucun `.env` n'est lu depuis
  le dossier de lancement, et les runners de forge démarrent sans les
  identifiants hérités du processus principal (#512).
- **Le renderer n'atteint que les projets enregistrés et les dossiers choisis**
  (lot M6), seule la page de l'app atteint un handler IPC, et les chemins
  d'outils (#511) comme le dossier du backend (#528) saisis dans les réglages
  sont vérifiés avant d'être exécutés.
- Mode hors-ligne strict pour `libdocs`, routes des providers refusées en mode
  serveur, `/health` réduit à son verdict (lot M4).
- CodeQL vert pour la release (#531) : tests de clé sur les URL autorisées
  seulement, clé Google en en-tête, hôte des remotes git comparé exactement,
  fichiers lus ou réécrits sans vérification préalable séparée, fichier
  temporaire du pair programming privé.

### 🛠️ Qualité

- **Une CI qui garde ce qui est livré** (lot M2) : déclencheurs sans liste
  blanche, une seule version de Biome, Python 3.12 testé, lockfile Python avec
  hashes, image serveur construite et migrée sur Postgres 16 en CI.
- **Contrats d'architecture** (lot M7) : chaque canal IPC nommé par sa
  constante et entendu des deux côtés, contrats d'import entre unités du
  backend, une ligne par vue dans `product-overview.md`.
- **Code mort retiré** (lot M8) : environ 17 800 lignes de modules qu'aucun
  code n'importait ; les vues expérimentales sont marquées et masquables.
- **Le cycle `core ⇄ agents` cassé et les fonctions géantes découpées** (lot
  M10) : `foundation/` sort de `core`, le plus grand cycle passe de 81 à 26
  unités ; `run_autonomous_agent`, la boucle QA, `create_client` et la fabrique
  de clients sont découpés sous des tests de caractérisation, sans changement
  de comportement.
- Doc et code alignés, palette de commandes traduite, jsdom à la demande (lot
  M9) ; `node-pty`, que rien ne chargeait, est retiré.
- Dépendances : Electron 45, electron-vite 6, chokidar 6, et les montées
  Dependabot de la semaine (FastAPI, SQLAlchemy, websockets, claude-agent-sdk,
  playwright, sentry-sdk, React, Vite).

---

## 1.3.0 - pi, filigranes retirés des fichiers générés, CI lisible

### ✨ Nouveautés

- **pi (pi.dev) est connu du dépôt et du cerveau** (lot 1 de
  [`docs/architecture/pi.md`](docs/architecture/pi.md)). Comme harness, pi lit
  `AGENTS.md` et `.agents/skills/` nativement, donc `capabilities/harnesses.yaml`
  le liste avec son vocabulaire d'outils et n'émet rien — aucune sortie de
  skills ne change. Comme agent du cerveau partagé, `brain/agents.py` sait où
  pi garde ses instructions (`~/.pi/agent/AGENTS.md`, ou `PI_CODING_AGENT_DIR`)
  et sa configuration MCP (`~/.pi/agent/mcp.json`) : `brain connect` et
  `bridge` le branchent comme les autres, sur `--apply`, après sauvegarde.
  La confiance qu'un projet demande à pi (`/trust`) reste une décision de la
  personne ; rien ici ne l'accorde. Les fixtures `tests/fixtures/pi/` sont six
  flux réels de pi 1.3.0 capturés sans secret (`capture.py`).
- **pi pilote une tâche** (lot 2 de [`docs/architecture/pi.md`](docs/architecture/pi.md)).
  Le provider **pi (CLI)** lance chaque phase dans `pi --mode json`, prompt sur
  stdin, événements JSON en retour, comme OpenCode. Les droits sont une
  allowlist réelle : la déclaration du type d'agent devient `--tools` dans les
  mots de pi, et un relecteur qui tente d'écrire reçoit `Tool write not found`.
  La session d'une tâche vit dans son dossier de spec et se reprend par id ;
  les skills du projet passent par `--skill .agents/skills` ; la confiance que
  pi demande pour `.pi/` (`/trust`) n'est jamais accordée à sa place, l'état
  est dit dans le fil de la tâche. Usage de chaque message mesuré dans le
  ledger du harness (`from_pi_usage`), `--thinking` depuis l'effort de la
  phase, badge **pi** dans la barre latérale, guide
  [`docs/integrations/pi.md`](docs/integrations/pi.md).
- **pi en mode RPC, et deux garde-fous** (lots 3 et 4). `WORKPILOT_PI_MODE=rpc`
  garde un processus pi par session : compaction à la demande, `abort` sur
  annulation, fenêtre du modèle lue dans `get_state`, prompt système envoyé
  une fois ; une question d'extension reçoit « annulé ». L'environnement de
  pi est construit (sans `NODE_OPTIONS`, `LD_*`, `DYLD_*`, clé JEV ni jeton
  OAuth de Claude Code), et un garde-fou d'écriture est chargé dans pi avec
  la politique de `security/path_guard` : hors du worktree, de la spec et du
  dossier temporaire, ou sur un fichier de garde-fous, un `write`/`edit` est
  refusé dans le processus pi lui-même — prouvé contre pi 1.3.0
  (`tests/fixtures/pi/guard-*.jsonl`). Un skill `tooling/pi` dit comment
  piloter pi sans interface (lot 5).

- **Les fichiers générés sortent propres.** Espaces de largeur nulle, espaces
  exotiques, contrôles bidirectionnels, caractères de balise : c'est ainsi qu'une
  marque de provenance voyage dans la sortie d'un modèle, et elle survit à chaque
  copier-coller vers un dépôt. Dans de la prose, c'est invisible et sans
  conséquence ; dans un fichier source, c'est une `SyntaxError` que personne ne
  voit, un identifiant qui ne s'égale pas lui-même, un `grep` qui ne trouve rien.
  La table de décision Unicode de
  [watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover)
  (MIT) est vendorisée et épinglée, et chaque `Write`, `Edit`, `MultiEdit` et
  `NotebookEdit` d'un agent y passe **avant** que les octets touchent le disque —
  côté SDK Claude comme côté fournisseurs qui ne l'utilisent pas. Ce qui est
  retiré est consigné dans `<spec_dir>/watermarks.jsonl` : c'est le seul endroit
  du produit où WorkPilot modifie silencieusement ce qu'un modèle a écrit, et une
  modification invisible se doit d'être traçable. Rien ne peut faire échouer une
  build : le coût sur un fichier propre est un `str.isascii()`. Réglages :
  `WATERMARKS_ENABLED`, `WATERMARKS_NORMALIZE_SPACES` (désactivé — l'espace
  insécable est porteur de sens en typographie française), `WATERMARKS_STRIP_BIDI`
  (durcissement Trojan Source), `WATERMARKS_MAX_BYTES`.

### 🛠️ Qualité

- **La CI nomme le test qui échoue.** Chaque ligne `FAILED` / `ERROR` du résumé
  de pytest devient une annotation du job (`ci.yml`), lisible sans le journal
  brut (#468). Première prise : le test du journal d'un RUN demandait au shell
  d'étendre `$RUN_API_TOKEN`, ce que `cmd.exe` ne fait pas ; il parle désormais
  la syntaxe du shell de la plateforme (`%VAR%` sous Windows), et le job Windows
  repasse au vert.

---

## 1.2.1 - La build macOS Intel, et la chaîne de release qui la publie

La 1.2.0 annonçait six plateformes et n'en livrait que cinq. Cette version
existe d'abord pour livrer la sixième, et pour que le cas ne puisse pas se
reproduire silencieusement.

### 🐛 Corrections

- **La build macOS Intel manquait purement et simplement.** `package:mac` codait
  `--arm64` en dur, alors que les quatre appels du dépôt passent déjà une
  architecture explicite : le job « Intel » lançait
  `electron-builder --mac --arm64 --x64` et packageait de l'arm64 sur un runner
  `macos-15-intel`. Les deux jobs macOS produisaient le même binaire. Les
  utilisateurs de Mac Intel n'avaient rien à télécharger, et le lien du README
  renvoyait un 404.
- **Le README annonçait des plateformes non construites.** Le tableau de
  téléchargement était un modèle figé de six lignes dans lequel on substituait
  le numéro de version — jamais régénéré, donc une ligne périmée survivait de
  release en release. Il est désormais construit depuis les assets réellement
  attachés à la release : une plateforme absente est omise **et** signalée en
  `::warning::`, et une release sans aucun asset rend une phrase plutôt que six
  liens morts.
- **Le wiki ne se rafraîchissait jamais.** `wiki-narrative.yml` écoute
  `release: published`, mais un événement émis par `GITHUB_TOKEN` ne déclenche
  aucun workflow — la même règle qui empêchait déjà un tag de lancer sa release.
  `create-release` le dispatche maintenant explicitement.
- Un push wiki refusé faute de token rend un message actionnable au lieu d'une
  traceback, et n'échoue le job que si le sync était réellement configuré.

### 🔒 Sécurité

- **`py/stack-trace-exposure` sur le test de webhook** (alerte 74), restée
  ouverte après une première correction incomplète. La réponse ne dérive plus
  d'une exception : chaque motif de rejet est lu dans une table de littéraux,
  sur le modèle de `workflows/api.py`. L'appelant y gagne au passage un
  diagnostic précis — URL vide, schéma refusé, hôte irrésolvable, plage privée —
  là où tout était aplati en « Invalid input ».

### 🛠️ Coûts et dépendances

- **Le rafraîchissement narratif du wiki ne se repaie plus lui-même.** Une
  empreinte des documents sources garde la passe : une release qui ne touche ni
  `README.md`, ni `docs/CLAUDE.md`, ni `docs/CLI-USAGE.md` ne régénère plus une
  prose identique. Le modèle passe de `claude-sonnet-4-6` à `claude-sonnet-5`,
  plus récent **et** moins cher. Sur dix releases dont deux touchent la
  documentation, le coût passe d'environ 10,60 $ à 1,41 $.
- Dix montées de dépendances (claude-agent-sdk, alembic, h2, aiosqlite, psutil,
  vitest, autoprefixer, xstate, lucide-react, @uiw/codemirror-theme-vscode).

---

## 1.2.0 - Workflows déclaratifs, skills agnostiques et durcissement

Le moteur de workflow décide désormais réellement ce qui tourne, les skills
deviennent un standard partagé entre harnesses, et la surface HTTP du backend
cesse de renvoyer ses exceptions à l'appelant.

### ✨ Workflows déclaratifs

- **Le moteur exécute les phases qu'il déclare**, au lieu de seulement les élaguer — `workflows/<nom>/workflow.yaml` résout un build contre le niveau d'effort choisi, les capacités du provider et les fichiers touchés. **Activé par défaut** (`WORKPILOT_WORKFLOW_ENGINE=0` pour revenir au pipeline précédent).
- **Le profil résolu est visible avant le build**, dans le modal de tâche (`WorkflowProfileCard`) : les phases élaguées apparaissent à leur position déclarée avec leur motif, et un décompte par niveau répond à « qu'est-ce qu'un cran de plus m'apporterait ».
- Une phase demandant `subagent-per-task` chez un provider sans sous-agents **dégrade explicitement** en séquentiel avec reset de contexte, et la dégradation est lue à l'exécution plutôt que supposée.
- Un `hard_gate` n'est jamais élagué par l'effort ; une phase déterministe non plus, puisqu'elle ne coûte aucun appel API.

### ✨ Skills, sous-agents et boucle d'apprentissage

- **Skills au standard [Agent Skills](https://agentskills.io)** — `.agents/skills/<nom>/SKILL.md` est la source lue en production, quel que soit le LLM ; les miroirs par harness sont générés, et `pnpm run skills:check` échoue sur toute dérive.
- **Une seule lecture de frontmatter** (`skills_registry.frontmatter`) : le dépôt en portait quatre, dont trois tronquaient toute description finissant par une phrase entre guillemets.
- **Registre unique de sous-agents** (`agents/subagents/`) : défauts de phase, overlays langage et spécialistes de PR.
- **`mem-search`** — récupération progressive en trois paliers sur les traces de build et les patterns : l'index tient dans ~100 tokens et ne lit jamais le corps d'un enregistrement pour le lister.
- **hermes-agent** est supporté sans rien dupliquer : il lit le même `.agents/skills/`, et les skills qu'il rédige arrivent comme *candidats* sous `skills/_proposed/` — jamais adoptés automatiquement, faute de signal de vérification externe.

### 🔒 Sécurité

- **Les 141 alertes de code scanning traitées.** 132 étaient deux erreurs répétées une fois par module d'API, désormais corrigées à la source dans `core/api_safety.py` : `safe_error` mappe une exception vers une chaîne fixe par type, `validated_dir` normalise et confine un chemin fourni par l'appelant.
- `return {"success": False, "error": str(e)}` renvoyait à l'appelant des chemins résolus, des erreurs de driver et parfois des secrets — 99 sites corrigés.
- Le middleware d'auth du mode serveur ne distingue plus token expiré, malformé ou mal signé pour un appelant non authentifié.
- **Parsing XML durci** (`defusedxml`) : `coverage.xml` et le XML JUnit sont lus dans le dépôt en cours de build, donc contrôlés par un tiers.
- Fuite de secret en clair dans un log, ReDoS polynomial sur le parseur de licences, et sanitisation d'URL incomplète : corrigés.
- Toutes les alertes Dependabot ouvertes closes (esbuild `GHSA-g7r4-m6w7-qqqr`, @babel/core `GHSA-4x5r-pxfx-6jf8`).
- Mode serveur **fail-closed**, endpoints de credentials verrouillés, IDOR d'annulation de run et révocation de session corrigés, Electron patché, interpolation shell supprimée.

### 🐛 Corrections

- **`GET /api/workflow-profile/` répondait à personne** : un autofix CodeQL avait confiné `project_dir` au dépôt WorkPilot, alors que WorkPilot construit les projets *des autres*. Dix tests rouges et un panneau de tâche vide.
- Les libellés du menu latéral portaient des emoji qui ne s'affichaient pas.
- `bump-version.js` réécrivait les manifestes entiers en espaces alors que le dépôt indente en tabulations — une montée de version de deux lignes produisait un diff de 530 lignes.
- Assistant de configuration : projet introuvable et avance automatique.
- BOMs UTF-8 et un fichier UTF-16 nettoyés ; hooks husky réparés ; `aiohttp` déclaré.

### 🛠️ Qualité

- **CodeQL ne scanne plus C#** : les 3 seuls fichiers `.cs` du dépôt sont des extraits de documentation livrés par un skill, sans projet ni restore — l'analyse stagnait à 22 % d'appels résolus et la configuration restait en warning permanent.
- Les templates Angular qu'un formateur avait rendus incompilables sont restaurés et sortis de l'extension `.ts`, qu'ils n'auraient jamais dû porter.
- Actions tierces épinglées sur des SHA de commit ; Dependabot npm repointé sur la racine du workspace, où vit réellement le lockfile pnpm.

---

## 1.1.0 - Multi-Provider, Formula Lab & Autonomous Agents

A large feature release: WorkPilot AI is now fully provider-agnostic, gains
mid-task execution control, a cost/success estimation lab, and a wave of new
autonomous agents and integrations. 150+ features and 150+ fixes since 1.0.0.

### ✨ Multi-Provider & Model Support

- **Provider-agnostic pipeline** — drive every phase with Claude, OpenAI, Gemini, Grok, GitHub Copilot, Azure OpenAI, a local Ollama model, or any OpenAI-compatible endpoint.
- **Provider-neutral one-shot core** so title/terminal-name/spec-interview/visual-proof no longer assume Claude.
- **Provider-neutral conversation log** (JSONL) that is replayed into the next provider on resume.
- **Live + static model catalogs** unioned per provider, with provider-aware model selection.
- New models across catalogs: **Claude Opus 4.8**, Opus 4.7, **Fable 5**, plus Anthropic versioned models.
- **Centralized model registry** shared across backend modules.

### ✨ Execution Control

- **Hot-Swap LLM** — change provider, model, or reasoning effort mid-task; context is replayed onto the new engine on the next turn.
- **Pause & Resume** across all task statuses and Kanban cards, with provider switch on resume ("Reprendre avec…").
- **Per-phase re-run** — redo planning, coding, or validation on demand.
- **Execution formula gate** before starting a task.

### ✨ Kanban & Task Workflow

- **Formula Lab** — pre-flight cost/success estimation per Provider × Model × Effort, calibrated on real usage history, with EUR pricing, sortable comparison table, and a hybrid "Refine with AI" pass.
- **PR-first guided human review**, plus "approve & close" and reversible task abandon.
- Chip-based filter panel, task duplication, Quick Command Bar, previous/next task navigation, per-task phase indicator, and Kanban column selection from the task pop-in.
- Acceptance criteria imported from Azure/Jira and grouped by scenario.

### ✨ New Agents & Intelligence

- **Consensus Arbiter** — reconciles conflicting security/QA opinions into one verdict.
- **Agent Coach** — cost/model coaching from real usage.
- **Carbon Profiler** — energy (kWh) and carbon footprint of agent runs.
- **Release Coordinator** and a **Technical Debt** dashboard.
- **Flaky Test Detective**, **Virtual Reviewer**, **Blast Radius**, **Bounty Board**, loop detection, and self-review modules.
- **Agent Debugger** with persistent state and breakpoints, plus Agent Replay.

### ✨ Testing

- **Live / streaming test generation** surface.
- **.NET test automation**, target-test generation, strict/per-task **TDD mode**, and in-UI plan editing.

### ✨ Visual & Design

- **Design-to-Code** service and a **visual programming canvas** (architecture drawing → scaffold).
- **Visual proof** with automated screenshot capture, feature navigation, window-only capture, and PR-comment integration.
- **App Emulator** embedded in the task modal.

### ✨ Onboarding

- **Setup Hub** post-install checklist and a step-by-step **guided tour** (coachmarks), plus guardrails.

### ✨ Integrations & Collaboration

- **Multi-user server mode** — central deployment with JWT / Microsoft Entra auth, per-user claims, run manager, and invitation-only signup.
- **Azure DevOps authentication** for worktree operations; inline Azure/Jira images and richer work-item retrieval.
- **Slack / Teams bots**, real Self-Healing alert channels (Slack / email / GitHub), and Windsurf integration improvements.

### ✨ Memory, Analytics & Optimization

- **Graphiti memory integration** and a continuous **learning loop**.
- **Usage-tracking dashboard**, cost predictor, and cost estimator.
- **LLM token optimization** (system prompt, effort mapping, prompt caching, context compaction).
- **Smart-merge / rebase protection** for `.workpilot` preservation.

### 🔐 Security

- Audit-trail encryption, hardened security validation and sandbox approval, injection guard, license governance, and SSRF hardening on outbound webhooks.

### 🐛 Bug Fixes & Stability

- 150+ fixes, including Windows startup-freeze fixes (synchronous Credential Manager and subprocess spawns moved off the main thread), credential utilities, browser mock, streaming/WebSocket reconnection, worktree data-loss protection, and numerous i18n and UI corrections.

### 📚 Documentation

- Refreshed root, backend, and frontend READMEs with the latest features; corrected stale module paths; and updated the public wiki.

---

## 1.0.0 - Initial WorkPilot AI Release

Initial public release. The complete 1.0.0 feature list is in the
[git history](https://github.com/krovomi/WorkPilot-AI/blob/f385fe1/docs/CHANGELOG.md).
