# The shared brain (memory)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Memory System (the shared brain)

There is **one** memory: the shared Obsidian vault described in
[Le cerveau partagé](#le-cerveau-partagé-obsidian--graphify--mcp). What a build
learns — gotchas, patterns, what each file is for, what each session did — is
written there by `brain/project_memory.py`, and every reader asks it. See
*La mémoire des builds, dans le vault* below for the layout and the rules.

It used to be three. Graphiti / LadybugDB was the "primary" store when
`GRAPHITI_ENABLED` was set, files under `<spec_dir>/memory/` the "fallback"
otherwise, and the vault held what agents wrote themselves — so the coder, the
`get_session_context` tool, the Memories tab and the MCP server each read a
different one, and a gotcha recorded by one surface was invisible to the next.
`GRAPHITI_ENABLED` no longer selects a store, and no agent gets the Graphiti MCP
server by default (`AGENT_MCP_<agent>_ADD=graphiti` still adds it for someone
who asks by name). `integrations/graphiti/` remains only as legacy code.

## Le cerveau partagé (Obsidian + Graphify + MCP)

Chaque agent a sa mémoire — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, le
`MEMORY.md` de hermes, le workspace d'OpenClaw — et aucun ne lit celle des
autres. Une préférence dite à Claude Code un lundi est inconnue de Codex le
mardi. `apps/backend/brain/` est **un seul cerveau que tous les agents lisent et
écrivent, et qu'aucun ne possède** : un vault Obsidian, un `graph.json` au
format Graphify, un dépôt git synchronisé, servi par un serveur MCP.

```
<cerveau>/                       Réglages → Cerveau partagé, WORKPILOT_BRAIN_DIR, sinon ~/.workpilot/brain
  instructions/<slug>.md         une instruction partagée par note — `agents:` dit qui la suit
  knowledge/<slug>.md            décisions, faits, emplacements
  knowledge/projects/<p>/builds/ une note par tâche du Kanban, et ce qu'on y a appris
  knowledge/projects/<p>/memory/ LA mémoire des builds : pièges, conventions, fichiers, sessions
  agents/<agent>/…               instantanés des mémoires propres à chaque agent
  skills/graph-first-recall/     le skill de rappel graph-first, semé à l'init
  .workpilot-brain/brain.json    le marqueur : ce dossier est un cerveau (versionné)
  .workpilot-brain/INSTRUCTIONS.md  condensé généré (ignoré par git)
  graphify-out/graph.json        le graphe, reconstruit à chaque écriture (ignoré par git)
```

| Module | Répond à |
|---|---|
| `graph.py` | le `graph.json` au format node-link de Graphify, construit depuis les notes, et ses requêtes (`query`, `get_node`, `shortest_path`) |
| `sync.py` | commit → pull (rebase, puis merge) → push ; conflit = les deux versions gardées |
| `agents.py` | **la** table : où chaque agent garde sa mémoire et déclare ses serveurs MCP |
| `memories.py` | mémoire d'agent → cerveau (`ingest`), cerveau → mémoire d'agent (`bridge`) |
| `connect.py` | inscrire `workpilot-brain` dans la configuration MCP de chaque agent |
| `mcp_server.py` | le serveur MCP stdio |
| `vault.py` | `Brain`, le seul objet qu'appellent MCP, CLI et HTTP |
| `runtime.py` | le branchement sur **toutes** les features de WorkPilot |
| `learn.py` | ce que WorkPilot enregistre lui-même : chaque build, chaque merge |
| `project_memory.py` | **la** mémoire des builds (pièges, conventions, fichiers, sessions) — le seul magasin, lu et écrit par toutes les features |
| `images.py` | les images du vault lues par docintel (source d'un schéma, sinon OCR local), en cache par empreinte |

```bash
python apps/backend/runners/brain_runner.py --action init --remote git@github.com:moi/brain.git
python apps/backend/runners/brain_runner.py --action ingest --project-dir .   # importe les mémoires existantes
python apps/backend/runners/brain_runner.py --action connect                  # aperçu ; --apply pour écrire
python apps/backend/runners/brain_runner.py --action bridge  --apply
python apps/backend/runners/brain_runner.py --action watch                    # pendant qu'on édite dans Obsidian
```

**Le graphe est celui de Graphify, pas un format voisin.** Nœuds `id`, `label`,
`file_type`, `source_file`, `metadata` ; liens `source`, `target`. C'est ce qui
fait que le skill `graph-first-recall`, le serveur MCP de Graphify et tout
lecteur node-link fonctionnent sur le cerveau sans adaptation — et les outils
MCP `query_graph`, `get_node`, `shortest_path` portent les noms de ceux de
Graphify pour la même raison. Un `graph.json` que Graphify a écrit dans le même
fichier survit à la reconstruction : nos nœuds portent
`metadata.origin = "workpilot-brain"`, et seuls ceux-là sont remplacés.

**Le rappel descend une échelle.** `brain_recall` répond aux niveaux 1 et 2 —
les nœuds, leurs voisins, leur frontmatter — et `brain_read_note` au niveau 3,
dans un appel séparé : décider quel fichier mérite d'être ouvert est tout
l'intérêt des deux premiers.

**Chaque modification est poussée, chaque lecture est précédée d'un pull.**
`Brain.write` finit toujours pareil — graphe reconstruit, condensé réécrit,
ponts rafraîchis, commit, pull, push — et `before_read` tire le distant quand la
copie locale a plus de `BRAIN_PULL_INTERVAL` secondes. Le commit *précède* le
pull : ce qu'une personne a tapé dans Obsidian part avec la prochaine lecture
d'un agent, et `--action watch` le fait sans attendre d'agent. Le graphe et le
condensé sont dérivés, donc ignorés par git et reconstruits après chaque pull :
committés, deux machines ajoutant chacune une note seraient en conflit sur
`graph.json` à chaque synchronisation.

**Un conflit ne perd rien.** Une note par fichier rend les conflits rares ;
quand deux agents touchent la même note, le rebase est tenté, puis le merge, et
si les mêmes lignes divergent encore, la nôtre reste en place et la leur est
écrite à côté (`<nom>.conflict-<sha>.md`). Choisir un gagnant en silence serait
décider à la place de la personne lequel des deux agents avait raison. Les
chemins en conflit sont lus avec `-z` : en sortie ligne, git met entre
guillemets et échappe en octal un nom non ASCII (`"Id\303\251es.md"`), et une
note française partait sur GitHub avec ses marqueurs `<<<<<<<` dedans.

**La branche suivie est celle du distant.** Un cerveau créé ici sur `main` et
branché sur un vault gardé sur `master` suit `master` (`_remote_branch`) : il
tirait le distant pour vide et poussait une seconde branche à côté du vault.

**Similaire n'est pas doublon, et aucune des deux n'est perdue.** `remember`
cherche une instruction proche (mots à cinq lettres près, ou ratio de
caractères, seuil `BRAIN_SIMILARITY`) : trouvée, l'agent y est ajouté et sa
formulation est gardée sous la note ; sinon une note est créée. C'est ainsi que
le cerveau apprend qu'une instruction est *partagée*.

**Le pont s'ajoute à la mémoire de l'agent, il ne la remplace pas.** `bridge`
écrit un bloc délimité (`<!-- workpilot-brain:start -->`) dans le fichier de
mémoire global de l'agent : comment utiliser le cerveau, les instructions à
appliquer **en plus** des siennes, et celles qu'il suit déjà et que d'autres
agents partagent — une instruction similaire se lit comme une confirmation, pas
comme une seconde règle. Claude Code et Gemini importent le condensé par
`@chemin` ; les autres reçoivent la liste en ligne ; hermes, qui plafonne son
`MEMORY.md`, reçoit un pointeur et lit le reste en MCP. Le bloc est retiré avant
toute lecture d'instructions : sans cela, chaque `ingest` réimporterait le
cerveau dans lui-même, crédité à l'agent qu'on venait de brancher. Une
synchronisation ne rafraîchit que les fichiers qui portent déjà le bloc.

**Les fichiers des autres ne sont écrits que sur demande.** `connect` et
`bridge` affichent un aperçu ; `--apply` écrit, après une sauvegarde unique
(`*.workpilot-brain.bak`). Un JSON illisible n'est jamais réécrit ; un
`mcp_servers:` hermes déjà présent, ni une entrée Codex non gérée, non plus — le
fragment est rendu à la personne. TOML et YAML sont écrits en bloc délimité et
non par aller-retour de parseur, qui effacerait les commentaires d'un fichier
édité à la main. `connect_all --apply` n'installe rien chez un agent absent.
Pour Claude Code, la CLI `claude mcp add-json --scope user` est préférée à
l'édition de `~/.claude.json`, que Claude Code réécrit pendant qu'il tourne.

**Un secret n'est pas une connaissance.** Le cerveau a un distant : une ligne
qui ressemble à un identifiant est expurgée des instantanés et ne devient jamais
une instruction.

**Le serveur MCP n'a aucune dépendance.** Il est lancé par les agents *des
autres*, avec le Python qu'ils trouvent ; une dépendance absente là-bas est un
cerveau que personne ne joint. JSON-RPC 2.0 sur stdio, une ligne par message, et
le champ `instructions` d'`initialize` porte les règles d'usage : un agent jamais
branché par `bridge` les apprend en se connectant.

### Les images du vault, retrouvées par leur texte

Un vault ne contient pas que des notes : la capture collée dans une note du
jour, le schéma exporté de draw.io, la photo d'un tableau blanc. Le graphe les
voyait comme des liens fantômes — `![[schema.png]]` ne menait à rien — et
« où est le schéma du flux de commande ? » n'avait de réponse que si quelqu'un
en avait recopié les mots dans une note. `images.py` fait de chaque image un
nœud de `graph.json` (`file_type: image`) dont les métadonnées portent ce que
docintel en a lu — `ocr.text`, `ocr.engine`, `ocr.date` —, l'embed y mène, et
`brain_recall` la trouve par ce qu'elle dit, avec la ligne qui correspond
(`match`).

**La lecture est celle de docintel, pas une seconde.** Un export draw.io ou
Excalidraw embarque sa source et `parse_diagram` en lit les boîtes et les
flèches ; sinon `ocr_image`, avec la chaîne réduite aux moteurs **locaux** et
sans projet pour lire une politique — le cas précis où la chaîne refuse déjà
un moteur cloud. Le graphe est reconstruit après chaque écriture de chaque
agent : c'est le dernier endroit d'où une capture devrait quitter la machine,
airgap ou non. Et seuls les moteurs de la prévisualisation répondent : un
modèle de vision est trop lent pour une reconstruction, il est `deferred`
comme sur la carte du Kanban.

Puis la protection de docintel, dans son ordre : caractères invisibles,
secrets masqués (`docintel/redact.py`), `injection_guard`. Un texte signalé
n'est pas indexé du tout (`status: withheld`) : les métadonnées d'un nœud sont
ce que le rappel remet à un agent, et une consigne cachée dans une capture ne
doit pas en devenir une.

**La reconstruction reste rapide.** L'OCR coûte une seconde par image et le
graphe est reconstruit à chaque écriture, donc chaque réponse est mise en
cache par l'**empreinte du contenu** dans `.workpilot-brain/ocr-cache.json` —
ignoré par git comme `graph.json`, parce que dérivé : deux machines y
seraient en conflit à chaque synchronisation. Une image dont la taille et la
date n'ont pas changé n'est même pas re-hachée, une image renommée ou
dupliquée reprend la réponse de ses octets, et une image supprimée sort du
cache. Au plus `BRAIN_OCR_PER_BUILD` images nouvelles sont lues par
reconstruction ; les suivantes attendent la prochaine (`status: pending`).
Un moteur absent n'est **pas** mis en cache : installer Tesseract plus tard
doit suffire, sans vider quoi que ce soit.

Rien n'y suit un lien symbolique, ni un dossier caché (`.obsidian`, `.git`) :
un vault est le dossier de quelqu'un, et un lien vers `~/.ssh` n'est pas une
de ses images.

### Ce que docintel a validé, rappelé d'une tâche à l'autre

Une exigence acceptée depuis le cahier des charges d'un client, un tableau de
règles gardé, un schéma de tableau blanc corrigé et enregistré dans draw.io :
chacune est une décision prise par une personne devant une tâche, et elle ne
vivait que dans le dossier de spec de cette tâche. `docintel/knowledge.py` la
classe par `learn.record` (surface `docintel`) dans
`knowledge/projects/<projet>/docintel/`, rattachée à la tâche (`tasks:`), si
bien que la tâche suivante du même projet — dans une autre session, avec un
autre agent — la retrouve par `brain_recall`.

Ce qui est classé, et seulement cela : les exigences et critères **acceptés**,
les tableaux **non rejetés une fois la carte utilisée** (une proposition que
personne n'a regardée n'est pas encore une connaissance), et un
`*.whiteboard.drawio` dont le marqueur `host` a changé — une personne l'a
enregistré. La note dit dans sa première ligne qu'il s'agit de données, pas
d'instructions, et rien n'est écrit sous `instructions/` : une exigence d'un
projet appliquée à tous les agents de tous les projets serait une règle que
personne n'a décidée. Elle est réécrite après chaque décision et chaque
préflight **seulement si son contenu a changé** — sinon chaque build
committerait une note identique —, et rien n'est écrit quand aucun cerveau
n'existe.

### Brancher un vault Obsidian, un dépôt GitHub

Réglages → Intégrations → **Cerveau partagé** (`BrainSettings`, `GET/POST
/api/brain/settings`). Le choix est par personne, pas par projet, et vit dans
`~/.workpilot/brain.json` : les processus qui en ont besoin sont des processus
Python — lancés par l'application, par la CLI, par les agents des autres — et un
fichier est la seule chose qu'ils peuvent tous lire. `WORKPILOT_BRAIN_DIR` gagne
toujours, et le champ passe alors en lecture seule : un réglage qui ne gagne pas
ne doit pas avoir l'air de gagner.

`Brain.init` distingue trois cas, d'après ce qu'il y a sur le disque :

| Dossier | Ce qui se passe |
|---|---|
| absent ou vide, un distant donné | **cloné** — un cerveau d'une autre machine, ou un vault gardé sur GitHub |
| absent ou vide | un nouveau cerveau, avec son README et ses dossiers |
| tout le reste | **adopté** tel quel — un vault Obsidian que la personne a déjà |

**Un vault adopté ne voit rien apparaître à sa racine.** Le marqueur et le
condensé vivent dans `.workpilot-brain/`, qu'Obsidian ne liste pas ; pas de
README, pas de note générée. Ses notes deviennent celles du cerveau : le rappel
lit tout le vault, et c'est tout l'intérêt de le brancher. Un vault déjà sous git
(le plugin obsidian-git) garde son dépôt et son `.gitignore`, auquel on ajoute
seulement les lignes dont le cerveau a besoin. Un clone raté dit pourquoi au lieu
de laisser derrière lui un cerveau vide.

**Deux garde-fous, parce que l'API locale est joignable depuis un navigateur.**
Le dossier choisi reste sous le répertoire personnel : un endpoint qui crée un
dépôt git là où on le lui dit écrit dans `/etc` pour qui le demande. Sous
WSL, le backend est un processus Linux et le vault de l'Obsidian Windows vit sur
`C:` — sous le profil ou ailleurs, `C:\Repository\…` compris. `brain/wsl.py` lit
`C:\…` comme `\\wsl$\<distro>\…` comme le chemin que ce processus ouvre
(`/mnt/c/…`, racine d'`/etc/wsl.conf`) et accepte un dossier d'un lecteur
Windows, sauf sa racine, les dossiers système (`Windows`, `Program Files`,
`ProgramData`…) et `Users` hors du profil de la personne — tout `Users` quand
le profil est inconnu (`windows-system`) : ceux-là sont précisément les endroits
visés. Le chemin est jugé tel que saisi **et** résolu, pour qu'un lien
symbolique ne mène pas à `C:\Windows` ni à `/etc`. Le sélecteur s'ouvre sur le profil
(`browseRoot`), faute de quoi une boîte GTK lancée depuis WSL ne montre aucun
lecteur Windows. Et un
distant est un distant (`sync.normalize_remote`) : `utilisateur/dépôt` pour
GitHub, sinon https, ssh, `git@hôte:`, file ou un chemin. Une valeur qui commence
par `-` est une option pour `git clone` (`--upload-pack=…` lance un programme) et
`ext::` est un transport qui en lance un aussi ; les deux sont refusés avant que
git ne les voie, et les commandes passent `--` avant leurs arguments positionnels. Les
refus et les échecs reviennent sous forme de **codes** (`outside-home`,
`invalid-remote`, `auth`, `not-found`, `locked`, `identity`, `rejected`…) que
l'interface traduit, **et** avec les mots de git (`detail`, `_git_detail`) : le
code dit quel genre d'échec, le détail dit lequel, et c'est lui qu'on colle dans
un moteur de recherche. Une ligne, les trois premières de git, sans les
identifiants qu'une URL peut porter (`https://user:token@…`) ; le journal reçoit
la même ligne avec l'étape (`commit`, `fetch`, `pull`, `push`). Un message
« détails dans le journal » dont le journal ne contenait que le code n'aidait
personne. Et aucune exception imprévue ne sort en 500 : sans en-têtes CORS, le
renderer n'en lit que « Failed to fetch ».

**Le frontmatter est celui d'une personne.** `date: 2024-01-01` — notes
quotidiennes, propriétés Obsidian — est un objet `date` pour YAML ; une seule
note de ce genre rendait `graph.json` impossible à écrire. `graph._plain` ramène
chaque valeur à du JSON.

### Ce que la tâche a appris, dans le Kanban

`BrainTaskCard`, dans le panneau de tâche (`GET /api/brain/task`). Le serveur MCP
lancé pour un build porte `WORKPILOT_BRAIN_TASK=<projet>/<spec>`, et l'exécuteur
d'outils des autres fournisseurs passe la même référence : chaque note et chaque
règle écrites pendant la tâche portent `tasks:` et un lien vers la note de build.
La carte lit le graphe, pas chaque fichier d'un gros vault, et ne tire pas le
distant : ouvrir un panneau n'est pas une raison d'attendre le réseau.

Elle ne s'affiche que quand le cerveau a quelque chose de cette tâche. Elle
montre la note de build (verdicts QA et tests, `acceptée` après un merge), les
notes apprises, et les **règles proposées**, qu'une personne active ou refuse sur
place : c'est devant la tâche qui l'a fait naître qu'on juge le mieux une règle.
« Ouvrir dans Obsidian » ouvre la note par son chemin (`obsidian://open?path=`),
d'où `obsidian:` dans les schémas qu'`open-external.ts` accepte — il ne lance que
l'application Obsidian, jamais un programme arbitraire.

### Branché sur toutes les features

Aucune feature ne parle au cerveau d'elle-même. Planner, coder, QA, pipeline
de spec, insights, idéation, roadmap, runners GitHub/GitLab, self-healing :
chacune construit son agent par `create_client` et son prompt par
`build_base_system_prompt`, et les fournisseurs sans SDK Claude exécutent leurs
outils dans `tool_executor`. Ces trois points sont branchés une fois, comme rtk
et watermarks : une feature ajoutée le mois prochain est branchée parce
qu'elle a été écrite normalement.

| Où | Ce que le cerveau ajoute |
|---|---|
| `get_required_mcp_servers` + `create_client` | le serveur `workpilot-brain` et ses outils autorisés, pour **tout** agent qui a des outils (pas `commit_message` ni `merge_resolver`). Il n'est pas déclaré agent par agent dans `AGENT_CONFIGS` : une liste à tenir à jour, c'est la prochaine feature débranchée. `AGENT_MCP_<agent>_REMOVE=brain` le retire |
| `build_base_system_prompt` | `awareness_section` : rappel graph-first, apprendre en travaillant, et les instructions partagées **en plus** des règles de la tâche. Lue sur disque, jamais tirée du réseau, stable au byte près pour le cache de prompt |
| `tool_executor` | les mêmes outils pour Copilot, OpenAI, Gemini, Ollama…, exécutés dans le processus |

L'apprentissage a deux moitiés. Les agents écrivent quand ils remarquent
quelque chose (le prompt le leur demande) ; ça dépend d'un modèle qui le décide.
`learn.py` est l'autre moitié : ce que WorkPilot **sait**, enregistré qu'un
agent y ait pensé ou non.

| Surface | Moment | Note |
|---|---|---|
| `build` | fin de chaque build Kanban/CLI (`_record_build_in_brain`), à tout niveau d'effort, moteur de workflow ou non | `knowledge/projects/<projet>/builds/<spec>.md` : la demande, le verdict QA et tests (`non mesuré` n'est pas `vert`), les fichiers touchés |
| `merge` | un merge depuis le Kanban (`run.py --merge`) | la même note, `status: merged` : une personne a relu le diff et dit oui |
| les autres | `POST /api/brain/learn` avec une surface de `SURFACES` | `knowledge/projects/<projet>/<surface>/…` |

Chaque note de build pointe vers `knowledge/projects/<projet>/index.md`, si bien
qu'un seul `brain_recall` répond à « qu'a-t-on fait sur ce projet, et qu'est-ce
qui a été accepté », depuis n'importe quel agent. Le nom du projet est lu à
travers le worktree : sinon chaque tâche serait classée sous un « projet »
différent.

**Les agents de WorkPilot proposent des règles, une personne les active.** Une
instruction active est injectée dans le prompt de tous les agents, sur tous les
projets. Et un agent de build lit, dans la même session, des issues, des PR et
des pages web, qui peuvent toutes lui demander de « retenir » n'importe quoi. Le
serveur que WorkPilot lance pour ses propres agents porte donc
`WORKPILOT_BRAIN_ORIGIN=workpilot`, et l'exécuteur d'outils appelle le cerveau
en non fiable. Dans ce mode, un agent :

- écrit des connaissances (`knowledge/`), rappelées à la demande et lues comme
  des données ;
- **propose** des instructions (`status: proposed`), qui ne s'appliquent à
  personne tant qu'une personne ne les a pas activées ;
- ne touche ni à une instruction en vigueur, ni aux skills, ni aux instantanés
  de mémoire.

Les agents qu'une personne branche elle-même par `connect` (Claude Code,
Codex, hermes…) écrivent en son nom, sans cette restriction. Pour activer ou
refuser une proposition : `--action proposals`, puis `--action promote` ou
`--action reject` avec `--path` ; ou bien changer `status:` dans Obsidian.

**Actif seulement quand un cerveau existe — et il existe dès qu'un build a
appris quelque chose.** `BRAIN_ENABLED` vaut `true` par défaut ; sans cerveau
sur disque, chaque point d'entrée *de lecture* répond en un `is_file` et
n'ajoute rien — pas de serveur lancé, pas de section de prompt, pas d'outil.
La première *écriture* de mémoire (voir ci-dessous) crée un cerveau local, sans
distant : rien ne quitte la machine tant qu'une personne n'a pas branché un
vault ou un dépôt dans les Réglages, et c'est là que reste la décision.
`BRAIN_ENABLED=false` coupe la mémoire ; il ne l'envoie plus ailleurs.

| Variable | Défaut | Rôle |
|---|---|---|
| `WORKPILOT_BRAIN_DIR` | `~/.workpilot/brain` (`%APPDATA%\WorkPilot\brain`) | où est le cerveau |
| `BRAIN_ENABLED` | l'interrupteur des Réglages, sinon `true` | branche le cerveau sur toutes les features, quand il existe |
| `WORKPILOT_BRAIN_CONFIG` | `~/.workpilot/brain.json` | où les Réglages enregistrent le dossier et l'interrupteur |
| `BRAIN_PULL_INTERVAL` | `60` | secondes entre deux pulls avant lecture |
| `BRAIN_AUTO_PULL` / `BRAIN_AUTO_PUSH` | `true` | pull avant lecture / push après écriture |
| `BRAIN_SIMILARITY` | `0.72` | seuil au-delà duquel deux instructions n'en font qu'une |
| `BRAIN_OCR_ENABLED` | `true` | lit les images du vault pour les indexer ; `false` les laisse hors du graphe |
| `BRAIN_OCR_PER_BUILD` | `10` | images nouvelles lues par reconstruction du graphe, le reste attend la suivante |
| `BRAIN_OCR_MAX_IMAGES` | `300` | images du vault prises en compte au plus |

`GET /api/brain/status`, `POST /api/brain/sync` et `POST /api/brain/recall`
exposent la même chose au desktop ; comme `hermes/api.py`, le routeur est refusé
en mode serveur — le cerveau vit dans le répertoire personnel de la machine qui
exécute le backend.

### La mémoire des builds, dans le vault (`project_memory.py`)

Ce qu'un build apprend sur un projet vit sous
`knowledge/projects/<projet>/memory/`, une note Obsidian par fait :

| Dossier | Une note par | Écrit par |
|---|---|---|
| `gotchas/` | piège, et sa solution quand on la connaît | outil `record_gotcha`, fin de session, revues de PR (GitHub, GitLab, Azure DevOps — critiques et hautes seulement) |
| `patterns/` | convention à suivre, et où elle s'applique | fin de session, extracteur d'insights |
| `codebase/` | fichier du projet : à quoi il sert | outil `record_discovery`, extracteur d'insights |
| `outcomes/` | sous-tâche : l'approche, et pourquoi elle a marché ou non | extracteur d'insights, learning loop |
| `sessions/<spec>/` | session de code ou de QA | `save_session_memory` |

Le frontmatter porte `memory:` (le type), `project:`, `spec:` et `tasks:`, et
chaque note est liée au hub du projet et à la note de build de la tâche : la
carte `BrainTaskCard`, `brain_recall` et Obsidian lisent donc exactement ce que
le coder lit. **La mémoire est par projet, pas par spec** : la tâche suivante du
même projet part de ce que celle-ci a appris.

**L'API est celle qu'avaient les appelants.** `ProjectMemory` répond aux
méthodes de `GraphitiMemory` (`save_gotcha`, `get_patterns_and_gotchas`,
`get_session_history`, `close`…) ; `memory.store.get_project_memory` est la
seule porte, et `memory.graphiti_helpers.get_graphiti_memory` n'en est plus
qu'un alias. Coder, QA reviewer, QA fixer, auto-fix, outils des agents,
pipeline de spec, idéation, roadmap, context builder, runners de revue,
`mem_search` (`BrainSource`) et l'onglet Mémoires (`GET /api/brain/memories`)
passent tous par là.

**Une synchronisation par session, pas par note.** Les notes sont écrites par
`Brain.write(sync=False)` ; `close()` committe, tire et pousse une fois. Chaque
texte passe par l'expurgation des secrets du cerveau, et tout est écrit en
non fiable (`knowledge/` seulement) : ce sont des données, pas des règles.

**Rien n'est perdu à la mise à jour.** Les anciens fichiers de
`<spec_dir>/memory/` (`codebase_map.json`, `patterns.md`, `gotchas.md`,
`session_insights/`) sont importés au premier usage de la mémoire de la spec,
puis rangés dans `<spec_dir>/memory.migrated-to-brain/` — jamais par-dessus un
premier import. L'état de reprise que `services/recovery.py` garde dans le même
dossier (`attempt_history.json`, `build_commits.json`) est de l'état
d'exécution, pas de la connaissance : il reste où il est. Pour tout importer
d'un coup : `brain_runner.py --action import-legacy --project-dir <projet>`.

## Memory Search (`mem-search`)

Three-layer progressive retrieval over the records that already exist — `learning_loop`
patterns, the project's memory in the shared brain (`BrainSource`, read from the
vault's `graph.json`) and `task_logger` traces — so an agent can ask "have we hit this before?"
without paying for every candidate to discard most of them.

```python
from mem_search import search_for

memory = search_for(project_dir)
index = memory.index("flaky timeout in the integration suite")  # ~100 tokens, always
memory.timeline(index.ids()[:3])  # a couple of lines each
memory.detail("task:042-add-widget")  # the full record, by id
```

The index is held to a token budget by dropping entries and reporting the count, never
by truncating what it kept, and building it never reads a record body — a source that
loaded everything in order to list it would have moved the cost, not removed it.

The agent-facing side is `skills/tooling/mem-search/`. `claude-mem` is declared as an
**optional** pack (`pnpm run skills:bootstrap --pack claude-mem`) rather than installed:
its retrieval pattern is what was worth adopting, and taking the tool itself would add a
fourth memory with its own worker and two more stores.
