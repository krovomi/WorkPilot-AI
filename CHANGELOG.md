# Changelog

All notable changes to WorkPilot AI are documented here. The full historical
detail (including the complete 1.0.0 notes) lives in
[docs/CHANGELOG.md](docs/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

Initial public release. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for the
complete 1.0.0 feature list.
