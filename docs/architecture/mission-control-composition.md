---
feature: Mission Control, composition automatique
summary: >-
  Une équipe d'agents proposée d'après une description, une spec ou un modèle de session, sur les
  providers mélangés, filtrés par capacités et chiffrés par Cost Intelligence, moins chère sous un
  budget ; un agent bloqué rééquilibré (profil Claude, provider, modèle plus puissant) ; un
  historique local mesure l'adoption et calibre les estimations.
---

# Mission Control : composer l'équipe et la rééquilibrer (#344)

Ajouter des agents à Mission Control se faisait un par un, rôle, provider et modèle choisis à la
main (`AddAgentDialog.tsx`). Un débutant devait deviner « combien d'agents, lesquels, sur quel
modèle, pour refactorer ce module ? ». L'onglet **Composition automatique** du même dialogue
propose une équipe entière ; rien n'est créé avant que la personne l'applique.

## Ce que fait le lot 1

| Morceau | Où | Rôle |
|---|---|---|
| Modèles de session | `apps/backend/mission_control/templates.py`, `SessionTemplates.tsx` | « Correction de bug », « Nouvelle fonctionnalité », « Refonte de module », « Réponse à incident », et `generic` pour une description trop vague ; chaque rôle a un niveau (`flagship`, `standard`, `fast`), et les drapeaux `critical`, `optional`, `scales` |
| Signaux | `mission_control/signals.py` | taille de la spec, fichiers du plan ou nommés dans le texte, domaines (liste fermée, mots français et anglais), tests évoqués, pile et suite de tests du projet (`project/stack.py`), type de la carte (`tasks/classify.py`) ; aucun modèle |
| Modèle d'un rôle | `mission_control/model_pick.py` | le niveau résolu par `models_registry.tier_pick` (le plus proche au-dessus si le provider n'en a pas), le modèle local configuré pour un runtime local (`phase_config.local_default_model`), le modèle propre d'un agent CLI ; prix du catalogue `cost_intelligence.catalog`, capacités détectées |
| Composition et budget | `mission_control/composition.py` | l'équipe, puis l'échelle de dégradation sous un budget |
| Second avis | `mission_control/refine.py`, `main/mission-control/mission-control-composition.ts` | un modèle rapide du premier provider répond à quatre questions fermées |
| Route | `POST /api/mission-control/composition` (`mission_control/api.py`) | locale seulement (`LOCAL_ONLY_FEATURES`) |
| IPC | `missionControl:suggestComposition` (preload `mission-control-api.ts`) | le main vérifie chaque champ et fait d'un `projectId` le dossier du projet |
| UI | `AutoComposePanel.tsx`, onglet de `AddAgentDialog.tsx` | choix, équipe proposée, écart de coût, application |

## Comment l'équipe est choisie

1. **Le modèle de session** : celui que la personne a choisi ; sinon celui que le modèle rapide a
   nommé ; sinon celui du type de la carte (`bug_fix` → correction de bug, `hotfix` → incident,
   `refactoring` et `upgrade` → refonte…) ; une description sans spec de moins de trois mots, ou
   de moins de six qui ne dit pas quel travail c'est, reçoit `generic` et l'avertissement
   `vague_input`.
2. **L'équipe** : un, deux ou trois développeurs selon la taille ; un testeur quand le projet a une
   suite de tests, que le texte parle de tests ou que le travail est grand ; un rédacteur pour un
   travail de documentation ; un architecte quand le travail touche trois domaines ou plus.
3. **Les modèles** : chaque rôle va au premier provider de la liste (dans l'ordre où la personne
   les a cochés) qui a un modèle capable de son niveau. Les providers se mélangent donc : un rôle
   que le premier ne sert pas va au suivant. Un provider sans adaptateur propre
   (`capabilities/providers.yaml`, `adapter: null` : meta, aws, cursor, custom) est écarté avec
   `provider_unsupported`, parce que Mission Control fait tourner chaque agent sur son provider et
   refuse un substitut (`requireProvider`).
4. **Les capacités**, jamais devinées d'après un nom : un rôle qui lit et modifie du code
   (architecte, développeur, relecteur, testeur, débogueur) refuse un modèle dont models.dev dit
   qu'il n'appelle pas d'outils (`public_model_registry.cached_tool_call`, cache seulement) ; tout
   rôle refuse un modèle dont la fenêtre utile (`context_mgmt.windows`, seuil de facturation longue
   compris) ne tient pas ce qu'un appel lit. Une capacité inconnue n'écarte pas le modèle. Un rôle
   qu'aucun provider ne sert est retiré avec `role_unserved`.
5. **Les coûts** viennent du catalogue Cost Intelligence, pour tous les providers. Copilot,
   Windsurf, Cursor et les runtimes locaux ne coûtent rien au token ; un modèle sans prix (un agent
   CLI qui choisit son modèle) n'est pas compté, et `unpriced_models` le dit. Les tokens sont un
   ordre de grandeur (contexte de base, spec, fichiers lus, par rôle) : de quoi comparer deux
   équipes, pas les facturer.

## Sous un budget

Un plafond en dollars ou en tokens applique ces étapes l'une après l'autre jusqu'à ce que l'équipe
tienne (`STEPS`) :

1. `non_critical_fast` : les rôles non critiques passent au niveau rapide, sur le provider le moins
   cher de la liste qui a un modèle capable ;
2. `single_coder` : un seul développeur ;
3. `drop_optional` : les rôles optionnels (testeur, rédacteur) sont retirés ;
4. `critical_standard` : un rôle critique haut de gamme passe au niveau standard ;
5. `cheapest_provider` : chaque rôle va au provider le moins cher de la liste, à son niveau.

La première équipe qui tient est proposée (`status: degraded`), avec l'économie, la liste des
changements et la qualité attendue : la somme des poids des niveaux (un rôle critique compte
double) rapportée à celle de l'équipe complète. Quand même la dernière ne tient pas, la composition
est refusée (`status: refused`) avec ce que demande la plus petite équipe ; un budget nul ou
négatif est refusé avant (`invalid_budget`). Un budget en tokens ne fait bouger que les étapes 2 et
3 : changer de modèle ne change pas le nombre de tokens estimé.

## Le second avis d'un modèle rapide

Il est optionnel (case à cocher). Le backend local ne détient aucun identifiant de provider ; il
écrit donc la demande (`refinement`) : le provider choisi en premier, son modèle rapide résolu par
le registre, un prompt neutre qui demande un objet JSON. La description y entre nettoyée et
délimitée (`security.untrusted.quote_untrusted`). Le main la fait passer par `runOneShotLLM`, qui
lance `core.oneshot` (la fabrique de clients) avec les identifiants du provider et
`requireProvider`, dans un dossier de spec jetable pour un agent CLI. La réponse revient au backend
(`model_hints`), qui n'en garde que des valeurs de listes fermées : le type de travail, la taille,
les domaines, le besoin de tests. Elle ne choisit ni un provider, ni un modèle, ni un rôle. Sans
réponse, les heuristiques décident seules et `refine_failed` le dit ; une réponse inutilisable
donne `hints_unusable`.

## Frontières

- Le renderer ne donne jamais de dossier : un `projectId`, résolu par `projectStore` dans le main,
  et un `specId` limité à `[A-Za-z0-9_-]`. Le backend revérifie : `validated_dir` pour le projet,
  `resolve_spec_dir` pour la spec (dossier résolu puis contenu dans le projet).
- Chaque refus est un code (`unknown_template`, `invalid_spec`, `no_provider`…) que la page
  traduit ; aucun chemin ni message d'exception ne revient à l'UI.
- La route est locale : `mission_control` est dans `LOCAL_ONLY_FEATURES` et ne se monte pas sur un
  serveur.

## Rééquilibrage en direct (lot 2)

| Morceau | Où | Rôle |
|---|---|---|
| Décision | `mission_control/rebalance.py` | la cause d'un échec, puis le remède ; aucune entrée réseau, aucun modèle |
| Plan de session | `mission_control/session_plan.py`, `POST /session/plan`, IPC `missionControl:setPlan` | les providers de l'équipe dans l'ordre choisi, son budget, l'interrupteur |
| Application | `MissionControlOrchestrator.rebalance_agent`, `POST /agents/{id}/rebalance` | change le provider et le modèle de l'agent, le journalise, compte |
| Relance | `main/mission-control/mission-control-runs.ts` | demande la décision avant d'enregistrer l'échec, relance la même tâche (`rebalanced: true`) |
| UI | `SessionHealth.tsx`, `AgentPanel.tsx`, `AgentEventLog.tsx` | budget dépensé, nombre de rééquilibrages, case à cocher, pastilles de la carte, ligne du journal |

Un run qui finit mal a l'une de trois causes, chacune son remède :

- **le provider a échoué** (`rate_limited` : limite de débit ou quota ; `provider_failed` :
  identifiant refusé, réseau, provider ou modèle introuvable) : la même tâche va au provider
  suivant du plan qui fait tourner un agent et a un modèle capable du même niveau (un modèle local
  ou choisi par une CLI vaut `standard` ailleurs). Pour une limite Claude, le main passe
  `rateLimitSource` à `runOneShotLLM` ; quand le système de profils Claude a un autre profil
  (`suggestedProfile`), l'agent reste sur Claude et repart sur ce profil (`retry_profile`) ;
- **l'agent a échoué** (toute autre erreur) : son modèle monte d'un niveau sur le même provider,
  `fast` → `standard` → `flagship` ; au sommet, ou si le niveau du dessus ne sait pas tenir le rôle,
  il va à un autre provider ;
- **la réponse tourne en boucle** : le backend, à chaque morceau reçu, cherche un passage de 30 à
  600 caractères répété cinq fois de suite à la fin de la réponse (une fenêtre égale à elle-même
  décalée d'une période, quel que soit l'endroit où le dernier morceau coupe ; un passage de moins
  de cinq caractères distincts, comme une règle de tirets, est de la mise en forme). Il le dit dans
  sa réponse à la mise à jour ; le main arrête le run et demande la décision, qui monte le modèle.

La cause se lit dans la liste fermée de `foundation.error_details.classify` ; le texte de l'erreur
n'est qu'une donnée classée, jamais une instruction, et ne choisit ni provider ni modèle : ceux-ci
viennent du registre (`model_pick.pick`), des capacités (`rebalance.capable`) et du plan.

Les garde-fous : deux rééquilibrages au plus par tâche (`MAX_REBALANCES`, remis à zéro quand la
personne lance une nouvelle tâche) ; aucun quand la session a atteint son budget (`over_budget`) ;
aucun quand la case est décochée. Une décision prise ou refusée laisse un événement
(`agent_rebalanced`, `agent_rebalance_skipped`, `agent_loop_detected`) que le journal traduit, un
nœud « Rebalanced » dans l'arbre de décision, et une pastille sur la carte. Sans plan (une équipe
montée à la main), les providers de repli sont ceux des agents de la session, dans l'ordre où ils
ont été ajoutés.

## Budget, métriques et calibrage (lot 2)

- **Budget de la session** : appliquer une équipe envoie son plan avant de créer les agents ; la
  session compare ce que les agents ont dépensé au budget (`over_budget`) et l'affiche, avec un
  avertissement une fois atteint.
- **Historique** (`mission_control/metrics.py`) : une session qui a dépensé au moins un token laisse
  une ligne à sa fin dans `<WORKPILOT_DATA_DIR ou ~/.workpilot>/mission-control/metrics.json`
  (`foundation.json_ledger`, 500 lignes au plus ; un fichier qui est un lien symbolique n'est ni lu
  ni écrit) : origine de l'équipe (`auto`, `manual`, `mixed`), tokens attendus et dépensés, budget
  et dépassement, rééquilibrages, et par rôle d'un agent composé ses tokens attendus et dépensés.
  Aucune tâche, réponse ni erreur n'y entre. `GET /metrics` en tire les quatre mesures de l'issue
  (part des sessions composées automatiquement, tokens moyens d'une session automatique et
  manuelle et leur écart, rééquilibrages par session, part des budgets dépassés) et le rapport
  dépensé / attendu ; l'écran d'accueil de Mission Control les affiche (`MissionControlMetrics.tsx`).
- **Calibrage** : dès qu'un rôle a trois relevés, son estimation de tokens est multipliée par la
  médiane de dépensé / attendu (bornée entre 0,25 et 4) ; la composition le dit (`calibrated`) et le
  panneau nomme les rôles calibrés.

## Pas encore fait

- **Lancer un agent secondaire** à côté d'un agent bloqué. Un run de Mission Control est un seul
  appel sans outils (`main/mission-control/mission-control-runs.ts`) : un second agent répondrait
  au même prompt une seconde fois, sans travail à se partager. Changer le modèle de l'agent bloqué
  est le remède qui convient à ce run ; un agent d'appoint aura un sens avec des runs longs, qui
  appellent des outils.
- **Boucle lue dans l'arbre de décision** (réflexions ou appels d'outils répétés) : ces runs ne
  remontent ni réflexion ni appel d'outil, la boucle se lit donc dans la réponse. Même raison.
- **Test en CI contre un Ollama local** des modèles de session : il faut un serveur Ollama et un
  modèle téléchargé sur les runners, ce que la CI n'héberge pas. La composition et le rééquilibrage
  n'appellent aucun modèle et marchent hors ligne ; le second avis n'est testé qu'avec un double.
- Capacité d'appel d'outils d'un modèle Ollama : seul le cache de models.dev est lu ; la
  détection en direct d'`ollama_model_detector` n'est pas appelée, pour ne pas joindre le serveur
  local pendant une composition ou un rééquilibrage.
- Les métriques sont celles de la personne, sur sa machine : aucune n'est envoyée ni agrégée entre
  utilisateurs, faute d'un service qui les recevrait.
