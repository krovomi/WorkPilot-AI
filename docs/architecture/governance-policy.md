---
feature: Gouvernance des agents et journal d'audit
summary: >-
  `workpilot.policy.yaml` fixe heures, fichiers interdits ou soumis à revue, jetons par heure et par
  tâche, limite du coupe-circuit ; invalide = refus et pause ; hook, flux de session de tous les
  providers, vagues du Swarm ; journal d'audit borné, export CSV/JSON ; en mode serveur, route
  gardée (approbation nommée par compte et rôles, arrêt d'urgence) lue par l'app et le mobile.
---

# Gouvernance des agents : heures, fichiers, budget de jetons

Issue #353, lots 2 à 4. Le premier lot ([agent-kill-switch.md](agent-kill-switch.md)) arrête un
agent qui tourne en rond et donne un bouton pour tout arrêter ; celui-ci dit, une fois pour toute
l'équipe, **quand** les agents travaillent, **ce qu'ils ne touchent pas** et **combien ils
consomment**, puis garde la trace de chaque décision.

## Où la règle est écrite

Dans `workpilot.policy.yaml`, le fichier de [garde-fous en code](guardrails.md) déjà versionné à la
racine du dépôt, à côté de ses `rules` :

```yaml
version: 1
schedule:
  timezone: Europe/Paris          # obligatoire : nom IANA, UTC ou UTC+02:00
  allowed_hours: ["08:00-19:00"]  # 1 à 8 plages ; "22:00-06:00" passe minuit
  days: [mon, tue, wed, thu, fri] # facultatif, tous les jours sinon
files:
  forbidden: ["**/migrations/**", ".env*"]   # jamais écrits par un agent
  requires_review: ["infra/**"]              # approbation unique d'une personne
  reviewers: [maintainer]                    # mode serveur : rôles qui peuvent la donner
budget:
  max_tokens_per_hour: 500000     # toutes les sessions du projet, 60 dernières minutes
  max_tokens_per_task: 2000000    # toutes les sessions d'une tâche, depuis le début
loop_detection:
  max_same_tool_call: 5           # appels identiques avant le coupe-circuit (2 à 100)
```

**Pourquoi ce fichier et pas un nouveau.** Il est déjà lu par les garde-fous, depuis le checkout
principal même quand l'agent tourne dans un worktree (`guardrail_policy.main_project`), il est déjà
dans les fichiers qu'aucun agent ne peut écrire (`path_guard.PROTECTED_CONFIG_NAMES`), et sa règle
« invalide = refus » existe. L'issue proposait `.workpilot/policies.yaml` : ce dossier est ignoré
par git, donc ni versionné ni relu.

**Seule la couche du dépôt porte ces sections.** La couche projet (`.workpilot/guardrails.json`)
est réécrite par l'écran des garde-fous, qui n'en garde que `rules` : une section posée là
disparaîtrait au premier enregistrement. Une section dans une autre couche est donc une erreur,
pas un réglage ignoré.

**Schéma strict, bornes** (`security/governance_policy.py`) : clé inconnue à chaque niveau (y
compris en tête de fichier, `version` autre que 1), fuseau absent ou inconnu, plage mal formée ou
vide, jour inconnu, plus de 8 plages ou 200 globs, glob absolu, avec `..`, lecteur Windows ou
caractère de contrôle, budget horaire hors de 1 000 à 1 000 000 000 (par tâche : jusqu'à
10 000 000 000), limite de boucle hors de 2 à 100 : la politique entière est refusée avec la liste
des erreurs, toute écriture et toute commande sont refusées jusqu'à correction, comme pour une
règle invalide, et chaque tâche se met en pause avant sa prochaine session (`policy_invalid`) :
le prompt ne part pas, son journal liste les cinq premières erreurs et sa carte dit combien il y en
a. Le hook seul laissait une session envoyer son prompt puis buter sur chaque outil. Une faute de frappe ne coupe jamais une limite en silence.

**Le fuseau est celui du fichier**, jamais celui de la machine : une équipe répartie lit la même
fenêtre. Un nom IANA demande les données de fuseau de Python, que Windows et le Python embarqué
n'ont pas : le backend dépend donc de `tzdata` (sans condition de plateforme, `zoneinfo` le lit
quand le système n'a rien), et `tests/security/test_governance_tzdata.py` lit `Europe/Paris` sans
aucune donnée du système. Une machine qui n'aurait toujours pas le paquet refuse le fichier et dit
d'écrire un décalage fixe (`UTC+01:00`).

**`files.reviewers`** (rôles du serveur, 20 au plus, minuscules, chiffres, `-` et `_`) dit qui peut
approuver un fichier soumis à revue. Il ne vaut qu'en mode serveur, où la personne qui répond est un
compte et ses rôles sont connus ; voir plus bas.

## Où elle s'applique

| Limite | Avant l'appel d'outil (hook) | Sur le flux de la session | Avant une session |
|---|---|---|---|
| fichiers interdits | refus (`deny`) | — | — |
| fichiers soumis à revue | demande d'approbation (`require_approval`) | — | — |
| heures | refus de toute écriture et commande | pause de la tâche (`policy_hours`) | coder, QA, vagues du Swarm |
| budget de jetons (heure, tâche) | — | pause de la tâche (`policy_budget`) | coder, QA, vagues du Swarm |
| politique invalide | refus de tout | pause de la tâche (`policy_invalid`) | coder, QA, vagues du Swarm |
| limite de boucle | — | coupe-circuit (`tool_loop`) | — |

- **Les fichiers deviennent des règles.** Chaque glob devient une règle de garde-fou
  (`files.forbidden:<glob>`, `files.requires_review:<glob>`) jugée là où les autres le sont : le
  hook PreToolUse de `create_client()` pour le SDK Claude, `guardrail_refusal` pour `ToolExecutor`.
  L'approbation, l'activité et l'essai à blanc de l'écran des garde-fous les voient donc sans rien
  de plus.
- **Le flux de session pour tous les providers.** `agents/policy_watch.py` est le troisième
  observateur de `SessionGuards` (après le coupe-circuit et la veille de sécurité) : il voit chaque
  session de chaque provider, SDK Claude, CLI Codex, Copilot, OpenCode, pi, agents ACP et boucle
  WorkPilot. Il juge au début de la session et à chaque appel d'outil ; la session s'arrête au
  message suivant, après l'action atomique en cours (le cas « 19 h passe pendant une action » de
  l'issue), et la tâche est mise en pause dans le même magasin que les budgets
  (`foundation.pause_state.pause_task`). Le coder et la QA demandent aussi avant de lancer une
  session (`policy_pause_before_session`), pour ne pas envoyer de prompt hors des heures.
- **Les jetons** sont ceux du relevé que tous les providers écrivent (`.workpilot/cost_data.json`,
  lu par `cost_budget.spend`) : entrée plus sortie, lectures de cache à part, toutes les tâches du
  projet pour la limite horaire, les lignes de la tâche (`spec_id`) pour la limite par tâche. Le relevé inscrit une session à sa fin : le plafond se vérifie entre les étapes, pas au
  milieu d'un appel de modèle, comme les [budgets de coût](cost-budgets.md).

**Reprendre** est le bouton Reprendre habituel. Hors des heures, la tâche se remet en pause au
premier contrôle ; la carte dit pourquoi (`TaskPolicyPause.tsx`) et une notification part quand le
processus s'arrête (`main/backend-pause-notify.ts`).

## Le Swarm (`agents/swarm/halt.py`)

Un Swarm, ce sont plusieurs coders à la fois : chacun voit la politique dans sa session, mais
l'orchestrateur, lui, lançait vague sur vague et réessayait les sous-tâches en échec. Un ouvrier
qui se met en pause (coupe-circuit, veille de politique, « stop » vocal) écrit sa copie de la spec
et celle du projet principal, que lit la carte, pas celle du worktree de la tâche que tient
l'orchestrateur : la vague suivante partait quand même, et chaque essai se remettait en pause.

Avant chaque vague (la première comprise, donc au lancement) et avant chaque nouvel essai,
l'orchestrateur demande `halt.stop_reason` : une pause dans n'importe quelle copie de la spec, ou
le verdict de la politique (heures, budgets, politique invalide, qui met alors la tâche en pause et
l'écrit au journal). S'il y en a un, rien ne démarre plus : la phase du Swarm passe à `paused`,
l'événement `swarm_cancelled` dit pourquoi, ce que la vague a fini est fusionné, et
`run_swarm_phase` remonte `BuildPaused` pour que le coder ne lance pas une session derrière.
Le lanceur autonome (`runners/swarm_runner.py`) affiche la raison et sort en erreur. C'est le cas
limite de l'issue « politique invalide au démarrage : refuser de lancer le Swarm avec un message
explicite » : la pause et sa raison, pas un repli silencieux sur l'exécution en série.

**Continuous AI.** Le démon que citait l'issue n'existe plus : les
[automatisations](automations.md) l'ont remplacé, et elles ne font que créer des cartes. Une carte
suit le cycle normal, donc chacune de ses sessions passe par cette politique ; il ne reste pas de
boucle à part.

## La limite du coupe-circuit

`loop_detection.max_same_tool_call` remplace la limite du [coupe-circuit](agent-kill-switch.md)
(cinq par défaut) pour toutes les sessions du projet. Le réglage de la machine
(`WORKPILOT_TOOL_BREAKER_LIMIT`) ne peut que la durcir : `0` (éteint) ou une valeur plus haute ne
lèvent pas la règle de l'équipe, une valeur plus basse s'applique. Chaque déclenchement, qu'il
vienne de la politique ou non, entre au journal (`tool_loop`, avec l'outil et la tâche) : c'est la
seule trace d'une boucle que l'export de conformité ne voyait pas.

**Écarté.** Le prompt (un modèle qui lit « ne travaille pas après 19 h » n'est pas une barrière) ;
un plafond de coût par jour en plus des [budgets de coût](cost-budgets.md), qui le font déjà par
période ; refuser les commandes Bash qui nomment un fichier interdit (une ligne de commande ne dit
pas ce qu'elle écrira, et le refus d'une lecture de `.env.example` serait un faux positif ; le bac à
sable de l'OS garde les écritures dans le worktree).

## Le journal d'audit (`security/policy_audit.py`)

Chaque décision de la politique ajoute une ligne JSON à `.workpilot/policy-audit.jsonl` du projet
principal : refus, demande de revue, approbation, avertissement, politique invalide, hors horaires,
budget atteint, coupe-circuit (liste fermée). Une ligne dit qui (utilisateur local), quand (UTC), quelle tâche,
quel outil et quel fichier ou commande (résumé expurgé), la décision, ses règles, la raison, le
provider et le modèle quand l'appelant les connaît. Une approbation dit aussi qui l'a donnée
(`approvedBy`, `policy_audit.approver_of`) : sur un serveur le compte, son id et ses rôles
(`Ada <u-1> [maintainer]`), sur le bureau le nom local suivi de « local, not verified ».

- **Borné** : au-delà de 4 Mo, seules les 10 000 dernières lignes restent.
- **Chemin résolu dans le projet, lien refusé** : `.workpilot` ou le journal en lien symbolique,
  le journal n'est pas écrit ; le fichier est ouvert sans suivre de lien quand la plateforme le
  permet, en `0600`. Un journal qu'on ne peut pas écrire ne bloque jamais l'agent : la décision
  s'applique quand même.
- **Protégé** : `policy-audit.jsonl` rejoint les fichiers de `.workpilot/` qu'aucun agent n'écrit,
  ni par `Write` ni par une commande (`PROTECTED_CONFIG_DIRS`).
- **Pourquoi pas `audit_trail/`** (la piste chaînée par empreintes) : sa chaîne interdit de la
  tronquer, elle grandit sans fin et se relit entière à chaque ajout, trop lourd pour un hook qui
  passe avant chaque outil ; et la couche `security` ne peut pas l'importer
  (`tests/test_import_contracts.py`).

## Le panneau (`GovernancePolicyPanel.tsx`)

Réglages → Garde-fous affiche, en lecture seule, ce que dit `workpilot.policy.yaml` : heures
(ouvert ou fermé maintenant, dans le fuseau du fichier), globs interdits et soumis à revue, budget
face aux jetons de la dernière heure, budget par tâche, limite du coupe-circuit, erreurs de
validation, les vingt dernières décisions et deux compteurs que demandait l'issue : les actions
d'agent arrêtées sur 24 h (refus, hors horaires, budget, politique invalide) et les déclenchements
du coupe-circuit sur 7 jours (`policy_audit.metrics`, relus nombre par nombre dans le main). Le
fichier se modifie dans le dépôt et se relit comme du code : un éditeur dans l'app réécrirait une
règle d'équipe sans revue.

**Export.** « Exporter en CSV » ou « en JSON » : le renderer nomme un projet enregistré et un format
de liste fermée ; le main relit le runner (`guardrails_runner.py audit`), reconstruit chaque
événement champ par champ, demande où enregistrer dans une boîte native et n'écrit que là
(`main/ipc-handlers/governance-handlers.ts`, `main/governance/audit-export.ts`). Une cellule CSV
qu'un tableur exécuterait comme formule (`=`, `+`, `-`, `@`) est précédée d'une apostrophe.

## Un projet du mode serveur (`shared_features/governance.py`)

Les agents d'un projet du serveur tournent sur le serveur, dans son clone : le panneau du bureau ne
pouvait lire ni leur politique ni leur journal, et « Arrêter tous les agents » ne les atteignait
pas. Le serveur lit donc lui-même le clone du projet et sert la gouvernance sous
`/api/features/governance`, par `project_id` comme toute feature partagée
([server-mode.md](server-mode.md#les-features-partagées)) : un projet d'un autre tenant répond
404, un non-membre 403, et la réponse ne contient aucun chemin du serveur (le préfixe du clone est
retiré, le dossier personnel devient `~`).

| Action | Route | Il faut |
|---|---|---|
| Lire la politique, les appels en attente, les agents et `may` | `GET /api/features/governance` | `audit.read` |
| Exporter le journal | `GET /api/features/governance/audit` | `audit.export` |
| Approuver ou refuser un appel | `POST /api/features/governance/approvals/{id}` | `review.approve`, rôle `member` ou plus ; pour approuver, un rôle de `files.reviewers` s'il y en a |
| Arrêter ses agents, ou tous ceux du projet | `POST /api/features/governance/stop` | `agent.cancel`, rôle `member` ou plus ; `project` : propriétaire du projet ou administrateur de l'organisation |

**L'approbateur nommé.** Le serveur répond au nom du compte connecté : l'approbation garde son id,
son nom et les rôles qu'il tenait (`guardrail_ledger.answer`, `verified`), le journal l'écrit, et
l'`AuditLog` du serveur aussi (`governance.approval.answered`). Quand `files.reviewers` nomme des
rôles, une approbation sans l'un d'eux est refusée (403) ; un refus reste ouvert à qui peut
approuver. Une demande déjà tranchée, ou tranchée par quelqu'un d'autre entre-temps, répond 404 :
une approbation ne sert qu'une fois. Sur le bureau seul, il n'y a pas d'identité vérifiée : le
panneau le dit (« sans identité vérifiée ») et le journal aussi.

**L'arrêt d'urgence.** Le serveur retient qui a lancé chaque run et chaque job
(`RunManager.stop_runs`, `ProjectJobs.stop_jobs`) : `mine` n'arrête que ceux de la personne, jamais
ceux d'un collègue ; `project` les arrête tous et reste au propriétaire, puisqu'une carte prise par
un autre est à lui. Un run arrêté est annulé, pas mis en pause : le serveur n'a pas de reprise à
la demande, la carte se relance. L'appel écrit `governance.stop_all` dans l'`AuditLog`.
« Arrêter tous les agents » de l'app envoie `mine` à chaque projet du serveur où la personne est
membre ou propriétaire (`main/server-governance.ts`, `stopServerAgents`), après l'arrêt local, et
le toast dit combien se sont arrêtés et quels projets n'ont pas répondu.

**Le délai.** Les deux arrêts envoient SIGTERM tout de suite. Deux tests le mesurent sur de vrais
processus et échouent au-delà de 2 s : `test_the_kill_switch_stops_the_agents_within_two_seconds`
(`tests/backend/test_shared_governance.py`, runs du serveur) et « kill switch latency »
(`stop-all-handlers.test.ts`, processus enfants tués par `killProcessGracefully`). Limite : un
processus qui ignore SIGTERM est tué de force après 5 s sur le bureau
(`GRACEFUL_KILL_TIMEOUT_MS`) ; le serveur n'envoie que SIGTERM. Les agents Python ne l'interceptent
pas, et `confined_run` remplace son processus par l'agent (`execv`), donc le signal l'atteint.

**Les vues.** Dans l'app, Garde-fous d'un projet du serveur affiche `ServerGovernancePanel.tsx` au
lieu de l'éditeur de règles du miroir : politique, approbateur, appels en attente (Approuver,
Refuser), agents (Arrêter mes agents, Arrêter tous les agents du projet après confirmation),
dernières décisions, export. Le main n'envoie qu'un id de projet, revalide chaque argument du
renderer (id de demande à 12 chiffres hexadécimaux, décision booléenne, portée et format en listes
fermées) et reconstruit la réponse champ par champ. Sur le téléphone, la page Gouvernance
(`apps/mobile/src/app/(app)/projects/[projectId]/governance.tsx`, lien du tableau avec
`audit.read`) montre la même chose, sans l'export. Chaque bouton n'apparaît que là où le `may` du
serveur l'autorise ; le serveur revérifie tout.

## Reste à faire sur #353

- ~~Swarm et Continuous AI~~ : fait au lot 3 (vagues et essais du Swarm, voir plus haut ; le démon
  Continuous AI a été remplacé par les automatisations). ~~Budget par tâche en jetons~~,
  ~~limite de boucle dans la politique~~, ~~trace du coupe-circuit et compteurs~~ : faits au lot 3.
- ~~Les tâches d'un projet du mode serveur~~, ~~un approbateur nommé pour `requires_review`~~,
  ~~`tzdata` pour les noms IANA~~, ~~le délai de l'arrêt d'urgence mesuré~~ : faits au lot 4 (voir
  plus haut).
- Hors de portée : un approbateur vérifié sur le bureau seul (il n'y a pas de compte à vérifier ;
  le serveur est la réponse), et un plafond de coût par jour (écarté plus haut, les
  [budgets de coût](cost-budgets.md) le font).
