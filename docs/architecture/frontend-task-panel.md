# Le panneau de tâche (frontend)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Le pourcentage d'une tâche (`shared/progress.ts`)

Une exécution produit **deux** nombres, et un seul répond à « où en est cette
tâche ? » :

| Champ | Échelle | Exemple |
|---|---|---|
| `phaseProgress` | 0-100 **à l'intérieur** de la phase courante | 15 = 15% de la planification |
| `overallProgress` | 0-100 sur **toute** la tâche, pondéré par `EXECUTION_PHASE_WEIGHTS` (planification 0-20, codage 20-80, QA 80-95) | 3 = 15% × la bande 0-20 |

Les deux étaient affichés côte à côte comme s'ils étaient comparables : la carte
du Kanban imprimait `phaseProgress` brut (« Planification 15% ») pendant que la
pop-in de détail imprimait `overallProgress` (« 3% »), pour la même tâche au même
instant. Le second est le bon, et c'est le seul qu'on montre désormais —
`resolveOverallProgress` le reconstitue depuis la phase quand l'enregistrement ne
le porte pas (plan persisté, snapshot XState), pour qu'aucune surface ne retombe
sur l'échelle locale à la phase.

La pondération elle-même vit dans `shared/progress.ts::calculateOverallProgress`
et **nulle part ailleurs** : `agent-events` l'appelle pour émettre, le renderer
l'appelle pour reconstituer. Deux copies de la formule, c'est deux réponses à une
question — exactement ce que 3% contre 15% donnait à lire.

La restauration d'une tâche depuis le disque suit la même règle : elle sait
quelle phase était en cours, pas où elle en était, donc elle suppose le milieu de
phase (`phaseProgress: 50`) et **pondère** — une tâche en planification revient à
10%, pas au 50% qui y était écrit en dur quelle que soit la phase.

Au-dessus de tout cela, `getDisplayProgress` garde ses deux priorités : dès qu'il
existe des sous-tâches, leur part terminée EST l'avancement réel (la pondération
par phase gonflerait à ~94% dès le démarrage de la QA), et un état terminal vaut
100% quel que soit un comptage en retard.

## L'onglet Vue d'ensemble (`task-detail/TaskOverview.tsx`)

L'onglet empilait une vingtaine de cartes, écrites chacune par une feature
différente. Rangées d'abord en quatre sections qui défilaient (à traiter, la
tâche, le plan, la mémoire), elles sont maintenant réparties en **trois
onglets**, par la question que se pose la personne. La table qui fait foi est
`task-detail/panel-sections.ts` (`PANEL_CARDS`) :

| Onglet | Répond à | Cartes |
|---|---|---|
| **Avancement** | où en est la tâche, que lui faut-il de moi pour avancer ? | entretien de spec et formule d'exécution (préalables), question d'un agent ACP, revue humaine (approbation du plan comprise), pipeline CI, suivi de la PR, la tâche (`TaskMetadata`), mode objectif, Best-of-N, vues MCP Apps |
| **Qualité** | ce qui a été construit est-il juste ? | JEV, traçabilité du spec, design system UI/UX, revue visuelle (OCR), boucle de vérification |
| **Coûts et contexte** | que coûte-t-elle, que lisent et retiennent les agents ? | profil d'exécution (ce que l'effort achète), pièces jointes et ADR, hermes, cerveau partagé, rtk |

Les autres onglets du panneau (Sous-tâches, Logs, Fichiers, Graphe, Visual
proof, Émulateur, Mobile, Vérification, Delta d'architecture) sont des vues
pleine hauteur, pas des cartes : ils restent des onglets du panneau.

L'onglet **Fichiers** (`TaskFiles.tsx`, liste dans `task-files-model.ts`)
montre d'abord les fichiers que la tâche a créés, modifiés ou supprimés : le
diff du worktree (`getWorktreeDiff`, la même liste que « Fichiers modifiés » de
la revue), lu dans le worktree ; quand ce diff est vide ou absent (branche
fusionnée, worktree supprimé), les fichiers enregistrés par les sous-tâches,
lus dans le projet. Le dossier de spécification (`.md`, `.json`) vient
dessous. Une tâche créée ou dupliquée depuis le tableau porte son `specsPath`
dès sa création, comme une tâche chargée du disque.

**Les trois panneaux restent montés**, seuls les inactifs sont `hidden` : une
carte charge ses données une fois, chaque onglet sait ce qu'il montre, et la
bannière ci-dessous peut amener à une carte de n'importe quel onglet. Les onglets
sont écrits à la main (pas les Radix du panneau, qui démontent l'inactif) selon
le motif WAI-ARIA : `tablist` / `tab` / `tabpanel`, un seul onglet dans l'ordre
de tabulation, flèches gauche/droite, Début et Fin, sélection au focus.
L'onglet ouvert est gardé pour la session dans `stores/task-panel-store.ts`, en
mémoire : aucun store d'interface existant ne convenait, et un choix qui
survivrait au redémarrage cacherait l'onglet Avancement d'une tâche qui attend.

**Une carte sans rien à montrer n'est pas rendue.** Chaque carte décide seule,
et rend `null` quand elle n'a rien à dire ; `PanelCardSlot` l'*observe*
(`MutationObserver` sur l'emplacement) plutôt que de recopier vingt règles, cache
l'emplacement vide et le signale à son onglet. Un onglet dont toutes les cartes
se taisent le dit en une ligne au lieu de disparaître : la barre ne change pas
sous le clavier. `GoalCard` rendait une coquille (titre et phrase « fixez un
objectif » sans bouton) pendant un run sans objectif : elle rend désormais
`null` dans ce cas.

**La barre d'onglets ne défile pas.** `TaskOverview` possède sa zone de
défilement et pose la barre au-dessus (un `sticky` sous un parent en
`overflow-x-hidden` partait avec le contenu). L'onglet Coûts et contexte porte
le nombre de décisions en attente (skills hermes, règles proposées au cerveau).

## « Ce qui vous attend » (`task-detail/TaskWaitingBanner.tsx`)

En haut du panneau, au-dessus des onglets, une bannière liste ce qui demande la
personne maintenant. Chaque ligne vient d'un état que l'application tient déjà
(`task-detail/waiting-items.ts`, fonction pure) et mène à la carte qui la traite :

| Ligne | Lu dans | Carte |
|---|---|---|
| question d'un agent | `task-permission-store` (validée par le main) | `TaskPermissionPrompt`, désormais aussi dans le panneau |
| plan à approuver | `status === "human_review"`, `reviewReason === "plan_review"` | la revue (`PlanApprovalSection`) |
| build en échec | `status === "error"` ou revue pour `errors` | `TaskFailureBanner`, juste en dessous |
| CI rouge | `task-store.pipelineStatuses` (le poller CI du main), sans réparation en cours | `CiPipelineCard`, nouvelle : le badge du Kanban et son bouton « Réparer le build », dans le panneau |
| checks rouges sur la PR | `pr-followup-store` : le dernier passage a vu des checks rouges ou a abandonné, et rien ne tourne | `PrFollowupCard` |
| objectif non atteint | `task.goal.status !== "met"`, une fois qu'aucun agent ne travaille | `GoalCard` |
| revue | toute autre revue humaine | la revue |

Une CI rouge que la réparation automatique traite déjà, ou des checks que le
suivi est en train de corriger, n'attendent personne : ils n'y sont pas. Rien à
faire, pas de bannière. Un clic ouvre la Vue d'ensemble, sélectionne l'onglet de
la carte (`task-panel-store.reveal`) ; l'emplacement de la carte défile à l'écran
et prend le focus dès qu'elle est rendue (elle peut charger après coup).

Le statut du suivi de PR vivait dans l'état local de sa carte, abonnée aux
événements tant qu'elle était montée. Deux lecteurs en ont besoin : il est dans
`stores/pr-followup-store.ts`, abonné une fois par `global-listeners.ts`.

## Deux cartes : la tâche et JEV

**Le titre et la description se modifient là où on les lit.** Un clic sur le
titre de l'en-tête (`EditableTaskTitle`) ou sur l'encart de la description
l'ouvre en champ ; Entrée (titre) ou Ctrl+Entrée (description) enregistre, Échap
annule sans fermer le dialogue. Un titre vidé n'est jamais envoyé — le main
process en inventerait un depuis la description — et rien n'est modifiable
pendant qu'un agent tourne, la même règle que le crayon. Classification et dates
sont le pied de l'encart, pas une barre à part entre deux filets.

**Des critères écrits dans la description sont des critères.** Quand
`acceptanceCriteria` est vide, `extractAcceptanceCriteriaFromDescription`
(`shared/utils/acceptance-criteria.ts`) lit la section « Critères
d'acceptation » de la description — titre HTML ou Markdown, ligne en gras, ou
ligne réduite au libellé — jusqu'au titre suivant. La rubrique les montre comme
*lus dans la description* et offre de les enregistrer ; rien n'est écrit dans
`task_metadata.json` sans ce clic.

**JEV a sa carte** (`TaskJevCard` → `jev/JevStatus.tsx`). Il était rendu à
l'intérieur du profil d'exécution, au-dessus de son titre, en une ligne d'état
brute. La carte dit ce qu'est JEV, dans quel état il sera à la prochaine
exécution, ce qu'il a répondu (couverture et risque sur leur échelle 0–2, en
jauge), et porte l'interrupteur **par workflow** — le même réglage que les
Réglages, écrit par `parseJevSettings`. La clé API reste dans les Réglages (un
secret ne se saisit pas dans un panneau de tâche) et le mode hors-ligne strict
gagne toujours : la carte le dit au lieu de proposer un bouton qui mentirait.
Les revues de PR/MR GitHub et GitLab affichent la même carte.

## Les critères d'acceptation en puces (`task-detail/acceptance-criteria-draft.ts`)

Les critères sont un `string[]` dans `task_metadata.json`, et ils s'éditaient
dans un textarea où une ligne valait un critère. Le format lit bien et s'édite
mal : une ligne de textarea n'est pas une chose. En supprimer une au milieu,
en déplacer une, savoir combien il y en a — ce sont trois opérations sur du
texte, faites à la main, sans rien pour dire qu'on s'est trompé de ligne.

Chaque critère est maintenant une puce à part entière : son champ, son bouton
de suppression, sa place dans la liste. Ce qui rend la chose possible est un
`id` stable par ligne (`CriterionDraft`), indépendant du texte et de la
position : c'est la clé React, et c'est la cible du focus après une insertion
ou une suppression. Un id dérivé du texte ferait de deux critères identiques
une seule ligne, et changerait à chaque frappe.

| Fichier | Rôle |
|---|---|
| `acceptance-criteria-draft.ts` | les règles sans React : découpage d'un collage, marqueurs de puce, insertion / suppression / déplacement, ce qui part à l'enregistrement |
| `AcceptanceCriteriaEditor.tsx` | les puces, le clavier et le focus |
| `TaskMetadata.tsx` | la section, les deux modes, l'enregistrement |

**Le mode texte reste offert à côté.** La liste est le mode par défaut et le
texte brut d'avant est à un clic : c'est lui qui fait bien ce que les puces
font mal — coller dix critères, en réordonner la moitié, tout effacer d'un
geste. Les deux éditent la même liste, et le passage de l'un à l'autre garde
la ligne vide qu'on vient d'ouvrir — d'où la chaîne propre au mode texte,
plutôt qu'un texte dérivé des puces à chaque frappe, qui supprimerait la ligne
sur laquelle on est en train de taper.

**Un critère tient sur une ligne**, parce que tout ce qui le relit découpe sur
les retours à la ligne. Entrée ouvre donc une puce au lieu d'insérer un saut,
un bloc collé devient une puce par ligne, et la normalisation se reprend à
l'enregistrement — un glisser-déposer de texte dans un champ n'appuie sur
aucune touche.

**Le marqueur de puce est retiré plus prudemment qu'à la lecture des
trackers.** `parseAcceptanceCriteriaText` lit un `<li>` où le marqueur est
certain ; ici la ligne vient de l'utilisateur, et « 3 tentatives maximum »
n'est pas une liste numérotée. Un chiffre ne compte comme marqueur que suivi
d'un point ou d'une parenthèse, et un marqueur doit être suivi d'une espace.

**Une puce vide n'est pas un critère** : elle existe dans l'éditeur, elle ne
part pas sur le disque. C'est ce qui permet de garder toujours un champ où
taper — supprimer la dernière puce en laisse une vide plutôt qu'une liste sans
champ — sans empêcher d'effacer la liste entière.

## Le chemin d'une tâche, en graphe (`shared/utils/change-graph.ts`)

La liste des fichiers d'un diff répond à « quoi ? » et jamais à « pourquoi
ensemble ? ». Une propriété ajoutée à une entité du Domain, reprise par un DTO
de l'Application, exposée par un contrôleur et vérifiée par un test est un
*chemin*, et il se lit dans le diff lui-même. L'onglet **Graphe des
modifications** du panneau de tâche (`TaskChangeGraph`, entre Sous-tâches et
Logs) le dessine, et le raconte :

> J'ai modifié la classe UserProfile dans la couche Domain et j'y ai ajouté la
> propriété BirthDate.
> ↳ Le DTO UserProfileDto reprend les données de la classe UserProfile (couche
> Domain) pour les faire passer à la couche Application.

| Question | Où elle se lit |
|---|---|
| quels éléments ? | les déclarations du patch (classe, interface, record, composant, hook…) ; un fichier qui n'en révèle aucun devient un nœud fichier |
| qu'est-il arrivé à leurs membres ? | une signature vue du seul côté `+` est ajoutée, du seul côté `-` retirée, des deux côtés modifiée ; un corps changé sous une signature en contexte modifie ce membre |
| dans quelle couche ? | le chemin : tests d'abord, puis les projets d'une solution (`App.Domain/`, `.Application/`, `.Infrastructure/`, `.Api/`), puis les dossiers qui le suggèrent |
| quel lien ? | une ligne que la tâche laisse dans A cite le nom de B — gardée comme **preuve** et affichée au clic sur l'arête. Bases (`: IFoo`) → hérite / implémente, handler → commande : traite, DTO → entité : transporte, test → teste, sinon utilise |
| pourquoi ? | les sous-tâches du plan qui déclarent le fichier |

**Aucun modèle, aucun réseau** — la même règle qu'`emulator-landing.ts`. Le
graphe est donc là dès qu'un diff existe, il ne coûte rien, et surtout il ne
peut pas raconter une relation que le code ne porte pas : une phrase générée
par un modèle se lirait exactement pareil qu'elle soit vraie ou non. Les
phrases sont des gabarits i18n (`tasks:changeGraph.*`) remplis avec des faits
mesurés.

**Pourquoi pas Graphify directement.** Graphify construit le graphe de *tout*
un dépôt, depuis l'AST, dans un processus Python lancé par un hook git ; la
question ici est ce qu'*un diff* a changé, membre par membre, et elle doit
répondre dans le renderer sans rien installer. Le graphe s'exporte en revanche
**au format node-link de Graphify** (`toGraphifyNodeLink`, bouton « Exporter
graph.json ») : mêmes clés que `brain/graph.py`, `metadata.origin =
"workpilot-change-graph"`, si bien que Graphify, son serveur MCP et le skill
`graph-first-recall` le lisent tels quels.

Les lockfiles et snapshots sont écartés et comptés ; au-delà de 60 nœuds, les
plus chargés sont gardés et le reste est compté — un graphe de trois cents
nœuds est une liste de fichiers dessinée.
