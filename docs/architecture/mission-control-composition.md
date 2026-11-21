---
feature: Mission Control, composition automatique
summary: >-
  Une équipe d'agents proposée d'après une description, une spec ou un modèle de session, sur les
  providers choisis et mélangés ; modèles filtrés par capacités, coûts du catalogue Cost
  Intelligence, équipe moins chère sous un budget, budget trop bas refusé.
---

# Mission Control : composer l'équipe (#344, lot 1)

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

## Pas encore fait

- **Rééquilibrage en direct** (lot 2) : lancer un agent secondaire ou monter le modèle d'un agent
  bloqué (erreurs répétées, boucle détectée dans son arbre de décision), avec notification. Les
  agents de Mission Control tournent aujourd'hui un seul tour sans outils
  (`main/mission-control/mission-control-runs.ts`) : il faut d'abord des runs longs à surveiller.
- **Profil de secours** quand un provider est limité (rate limit) : reprendre la composition sans
  lui.
- **Métriques** de l'issue : part des sessions composées automatiquement, écart de tokens entre
  équipes automatiques et manuelles, dépassements de budget.
- **Historique calibré** : les tokens par rôle sont des constantes ; les relevés des runs passés
  (`cost_intelligence.cost_predictor`) pourraient les remplacer.
- **Test en CI contre un Ollama local** des modèles de session : la composition n'appelle aucun
  modèle et marche hors ligne, mais le second avis n'est testé qu'avec un double.
- Capacité d'appel d'outils d'un modèle Ollama : seul le cache de models.dev est lu ; la
  détection en direct d'`ollama_model_detector` n'est pas appelée, pour ne pas joindre le serveur
  local pendant une composition.
