# Marketplaces MCP et plugins

> Code : `apps/frontend/src/shared/mcp-catalog/`, `apps/frontend/src/shared/plugin-catalog/`,
> `apps/frontend/src/main/plugin-marketplace/project-skills.ts`, `apps/backend/core/custom_mcp_validation.py`. Règles :
> [`rules/security.md`](../rules/security.md) S2, S3, S4 et S6.

## Le problème

Jusqu'au 2 novembre 2026, les deux vues étaient des maquettes. Installer un serveur MCP ou un
plugin écrivait un JSON dans `userData` que rien ne lisait : aucun agent ne recevait le serveur,
aucun prompt ne changeait. Sur les 17 paquets du catalogue MCP, 6 n'existaient pas sur npm
(`@anthropic/mcp-server-jira`, `-notion`, `-linear`…) et 8 étaient dépréciés ; les téléchargements
et les notes affichés étaient inventés. Les deux vues étaient marquées expérimentales.

## Ce qu'installer veut dire

| Marketplace | Ce qu'« Installer » écrit | Qui s'en sert |
|---|---|---|
| MCP | un serveur dans `CUSTOM_MCP_SERVERS` du `.workpilot/.env` du projet sélectionné, et son id dans `AGENT_MCP_<agent>_ADD` des agents cochés (planificateur, codeur, relecteur QA par défaut) | `core.client._custom_servers` le démarre pour ces agents ; le pont MCP de la boucle WorkPilot (`core/mcp_tools.py`) aussi ; l'onglet Outils des agents le montre et règle les agents |
| Plugins | `<projet>/.agents/skills/<id>/SKILL.md` et son miroir Claude Code `<projet>/.claude/skills/<id>/SKILL.md` | les commandes `/` du Kanban sur tous les providers (`slash_commands/api.py`), pi, les phases de workflow, Codex et Claude Code qui lisent ces dossiers |

Aucune des deux vues ne garde de liste à elle : « installé » est relu dans le projet. Ce que la
vue montre est donc ce que les agents reçoivent, et un serveur ajouté à la main dans Outils des
agents apparaît aussi dans l'onglet Installés.

## Le catalogue MCP

`servers.json` : 37 serveurs, chacun vérifié le 2 novembre 2026 sur npm, PyPI ou la doc de
l'éditeur (paquet existant, non déprécié, commande et variables d'après son README). Champs :
lanceur (`npx` ou `uvx`) et arguments, ou URL et en-têtes d'un serveur distant ; `vars`, ce que la
personne tape ; `env` fixe (par exemple `ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS=true` pour Kubernetes) ;
`requires` quand il faut uv ou Azure CLI ; textes en anglais et en français.

`${NOM}` dans un argument, l'URL ou un en-tête est remplacé par la valeur tapée ; un argument ou
un en-tête dont la valeur facultative est vide est retiré (`--project-ref` de Supabase, jeton de
Hugging Face). Une variable qu'aucun gabarit ne nomme va dans l'environnement du processus : c'est
pour cela que `CustomMcpServer` a un champ `env`. Un serveur distant n'a pas d'environnement, donc
chacune de ses variables doit être nommée par un gabarit (vérifié par le test du catalogue).

Choix des serveurs : l'officiel de l'éditeur quand il existe et accepte un jeton (GitHub distant,
Linear, Neon, Stripe, Sentry, Notion, Azure DevOps, Playwright, Chrome DevTools, Microsoft
Learn…) ; sinon le serveur communautaire le plus suivi (GitLab, Jira et Confluence par
`mcp-atlassian`, Slack, Datadog, Figma), marqué « Communauté ». Un serveur qui ne se connecte que
par OAuth n'est pas proposé : le SDK ne mène pas ce parcours dans une session d'agent. Les bases
de données sont lancées en lecture seule (`--access-mode=restricted`, `--readOnly`,
`--read-only`). Le serveur `filesystem` n'est pas repris : il donnerait à un agent des fichiers hors
de son worktree, ce que `path_guard` refuse.

## L'environnement d'un serveur

`env` passe par `validate_custom_mcp_server` (`core/custom_mcp_validation.py`) comme le reste : au plus 32 noms, chacun un
identifiant simple, ni `PATH`, ni un chargeur (`NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHONPATH`,
`BASH_ENV`…), ni un réglage de gestionnaire de paquets (`NPM_CONFIG_*`, `UV_*`, `PIP_*`…) qui ferait
télécharger un autre paquet à `npx` ou `uvx`, ni le jeton OAuth de Claude ; valeurs sans NUL,
8 Kio au plus. Le test de connexion du main (`mcp-handlers.ts`, `isMcpEnvSafe`) refuse les mêmes
noms et lance le serveur avec `envWithoutCredentials` plus son seul `env` : un paquet tiers ne
reçoit pas les identifiants de l'app.

Les valeurs restent en clair (fichier `0600`) dans `CUSTOM_MCP_SERVERS`, rangée `readable` de
`project-env-secrets.json` : le backend lit cette clé dans le fichier, comme les en-têtes
`Authorization` qui y étaient déjà. La boîte d'installation le dit.

## Les plugins

`plugins.json` : 24 skills (audit de sécurité OWASP, accessibilité WCAG 2.2, performance, revue de
code, i18n, tests ; .NET Clean Architecture, revue EF Core, revue d'API ASP.NET Core, tests xUnit ;
TDD, DDD, ADR, plan de refactoring, OpenTelemetry ; user story, OpenAPI, bug et cause racine, notes
de version, Conventional Commits, Dockerfile, SQL, montée de dépendances, composants React). Trois
types : agent, modèle de spec, prompt. Les types « thème » et « intégration » ont quitté le
catalogue : un thème n'était appliqué nulle part, et une intégration est un serveur MCP.

Le `SKILL.md` écrit porte `metadata.workpilot.plugin: <id>`. Seul un dossier qui a ce marqueur
compte comme installé et seul son `SKILL.md` est retiré à la désinstallation (le dossier ensuite,
s'il est vide) ; un skill du même nom écrit par quelqu'un d'autre fait refuser l'installation.
Le chemin du projet vient du `projectStore` du main, jamais du renderer ; un `.agents` ou un
`.claude` qui serait un lien vers l'extérieur du projet fait refuser l'écriture.

Chaque corps passe la gate 4 des skills (`skills_registry.injection_gate`) : aucun ne s'adresse à
l'agent par-dessus son lecteur.

## Ce qui le vérifie

| Test | Ce qu'il tient |
|---|---|
| `tests/test_mcp_catalog.py` | chaque serveur du catalogue, rempli comme `install.ts` le remplit (toutes les valeurs, ou les seules requises), passe `validate_custom_mcp_server` ; `env` arrive à la config du SDK ; les variables qui changent ce qui tourne sont refusées |
| `src/shared/mcp-catalog/__tests__/install.test.ts` | catalogue complet dans les deux langues, aucun gabarit restant, les paquets disparus absents, remplissage des arguments, en-têtes et `env`, ajout et retrait dans les agents |
| `src/main/ipc-handlers/__tests__/mcp-handlers-env.test.ts` | le test de connexion refuse les mêmes variables |
| `tests/test_plugin_catalog.py` | chaque corps passe la gate 4, le `SKILL.md` se lit avec son marqueur, un plugin installé est une commande `/` du Kanban |
| `src/main/plugin-marketplace/__tests__/project-skills.test.ts` | écriture dans les deux dossiers, refus d'écraser un skill étranger, désinstallation qui garde un fichier ajouté, lien symbolique vers l'extérieur refusé |

Les paquets eux-mêmes ne sont pas lancés en CI : le réseau du runner n'a pas les clés, et un
serveur distant ne répond pas sans elles. Le catalogue dit la date de sa vérification.
