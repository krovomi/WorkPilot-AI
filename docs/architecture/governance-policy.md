---
feature: Gouvernance des agents et journal d'audit
summary: >-
  `workpilot.policy.yaml` (lu dans le checkout principal) fixe heures permises, fichiers interdits
  ou soumis à revue et jetons par heure ; schéma strict, invalide = refus ; hook d'outils et flux de
  session de tous les providers ; journal d'audit JSONL borné, panneau en lecture seule, export CSV/JSON.
---

# Gouvernance des agents : heures, fichiers, budget de jetons

Issue #353, deuxième lot. Le premier lot ([agent-kill-switch.md](agent-kill-switch.md)) arrête un
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
budget:
  max_tokens_per_hour: 500000     # toutes les sessions du projet, 60 dernières minutes
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
caractère de contrôle, budget hors de 1 000 à 1 000 000 000 : la politique entière est refusée
avec la liste des erreurs, et toute écriture et toute commande sont refusées jusqu'à correction,
comme pour une règle invalide. Une faute de frappe ne coupe jamais une limite en silence.

**Le fuseau est celui du fichier**, jamais celui de la machine : une équipe répartie lit la même
fenêtre. Un nom IANA demande les données de fuseau de Python ; une machine qui ne les a pas
(Windows sans le paquet `tzdata`) refuse le fichier et dit d'écrire un décalage fixe (`UTC+01:00`),
qui ne dépend de rien.

## Où elle s'applique

| Limite | Avant l'appel d'outil (hook) | Sur le flux de la session | Avant une session |
|---|---|---|---|
| fichiers interdits | refus (`deny`) | — | — |
| fichiers soumis à revue | demande d'approbation (`require_approval`) | — | — |
| heures | refus de toute écriture et commande | pause de la tâche (`policy_hours`) | coder et QA |
| budget de jetons | — | pause de la tâche (`policy_budget`) | coder et QA |

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
  projet. Le relevé inscrit une session à sa fin : le plafond se vérifie entre les étapes, pas au
  milieu d'un appel de modèle, comme les [budgets de coût](cost-budgets.md).

**Reprendre** est le bouton Reprendre habituel. Hors des heures, la tâche se remet en pause au
premier contrôle ; la carte dit pourquoi (`TaskPolicyPause.tsx`) et une notification part quand le
processus s'arrête (`main/backend-pause-notify.ts`).

**Écarté.** Le prompt (un modèle qui lit « ne travaille pas après 19 h » n'est pas une barrière) ;
un plafond de coût par jour en plus des [budgets de coût](cost-budgets.md), qui le font déjà par
période ; refuser les commandes Bash qui nomment un fichier interdit (une ligne de commande ne dit
pas ce qu'elle écrira, et le refus d'une lecture de `.env.example` serait un faux positif ; le bac à
sable de l'OS garde les écritures dans le worktree).

## Le journal d'audit (`security/policy_audit.py`)

Chaque décision de la politique ajoute une ligne JSON à `.workpilot/policy-audit.jsonl` du projet
principal : refus, demande de revue, approbation, avertissement, politique invalide, hors horaires,
budget atteint (liste fermée). Une ligne dit qui (utilisateur local), quand (UTC), quelle tâche,
quel outil et quel fichier ou commande (résumé expurgé), la décision, ses règles, la raison, le
provider et le modèle quand l'appelant les connaît.

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
face aux jetons de la dernière heure, erreurs de validation, et les vingt dernières décisions. Le
fichier se modifie dans le dépôt et se relit comme du code : un éditeur dans l'app réécrirait une
règle d'équipe sans revue.

**Export.** « Exporter en CSV » ou « en JSON » : le renderer nomme un projet enregistré et un format
de liste fermée ; le main relit le runner (`guardrails_runner.py audit`), reconstruit chaque
événement champ par champ, demande où enregistrer dans une boîte native et n'écrit que là
(`main/ipc-handlers/governance-handlers.ts`, `main/governance/audit-export.ts`). Une cellule CSV
qu'un tableur exécuterait comme formule (`=`, `+`, `-`, `@`) est précédée d'une apostrophe.

## Reste à faire sur #353

- Swarm Mode et Continuous AI : leurs propres boucles (quiet hours et plafond journalier du
  démon) ne lisent pas encore cette politique ; leurs sessions, elles, passent par `SessionGuards`.
- Les tâches d'un projet du mode serveur : elles tournent sur le serveur, dont le panneau ne lit
  pas le journal.
- Un budget par tâche en jetons, et un approbateur nommé pour `requires_review` (attend les rôles
  du mode serveur).
- `tzdata` livré avec le Python embarqué de Windows, pour les noms IANA.
