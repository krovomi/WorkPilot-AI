# Le panneau de tâche (frontend)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
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

L'onglet empilait dix blocs dans l'ordre où ils avaient été écrits, et la
description de la tâche arrivait en neuvième position — la revue humaine, seule
chose qu'on vient faire sur une tâche en revue, en dixième. Il est rangé par la
question que se pose la personne :

| Section | Répond à | Contient |
|---|---|---|
| *(préalables)* | puis-je démarrer ? | entretien de spec, formule d'exécution — au-dessus de tout |
| **À traiter** | que dois-je faire maintenant ? | la revue humaine, quand la tâche l'attend |
| **La tâche** | de quoi parle-t-on ? | `TaskMetadata` |
| **Plan d'exécution** | que vont faire les agents ? | profil d'effort, JEV, traçabilité, pièces jointes et ADR |
| **Mémoire & apprentissage** | que retient le système ? | hermes, cerveau partagé, rtk |

Une barre de raccourcis collante mène à chaque section et porte le nombre de
décisions en attente (skills hermes, règles proposées au cerveau).

**Une section vide disparaît avec son titre et son raccourci.** Chaque carte
décide seule de s'afficher, et la plupart ne rendent rien quand elles n'ont rien
à dire ; la présence est donc *observée* (`MutationObserver` sur le corps de la
section) plutôt que recopiée : dix règles d'affichage dupliquées ici seraient dix
occasions de se tromper.

**La barre de raccourcis ne défile pas.** Elle était `sticky` dans la zone qui
défile, sous un parent en `overflow-x-hidden` — qui devient alors un conteneur
de défilement immobile, et le `sticky` un élément ordinaire. `TaskOverview`
possède désormais sa zone de défilement et pose la barre au-dessus ; elle est
toujours rendue (une barre qui apparaît quand une carte asynchrone arrive pousse
le contenu), et le raccourci de la section lue est allumé.

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
