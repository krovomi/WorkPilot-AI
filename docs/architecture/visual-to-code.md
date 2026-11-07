# Visual-to-code : architectures et historique

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Architectures et historique de construction (`visual-to-code/`)

Le canvas ne tenait qu'**un** diagramme, dans trois champs libres du store
(`canvasNodes`, `canvasEdges`, `canvasDiagramType`). En commencer un deuxième
détruisait le premier : « Nouveau diagramme » vidait le canvas, et la seule
façon de garder le travail était d'avoir pensé à exporter un JSON avant.

Une **architecture** est désormais un document — un id, un nom, ses blocs, ses
connexions — et les documents sont indépendants. L'id est ce sous quoi
l'historique est classé sur disque, ce qui est la raison pour laquelle il
survit à un renommage.

| Où | Quoi |
|---|---|
| `stores/visual-to-code-store.ts` | les documents, le document actif, et les actions d'historique |
| `components/visual-to-code/ArchitectureTabs.tsx` | la barre d'onglets ; c'est là que se crée un document |
| `components/visual-to-code/ArchitectureHistoryDock.tsx` | la frise des étapes, et le retour à l'une d'elles |
| `main/visual-to-code-history.ts` | le stockage : un fichier par architecture |
| `shared/types/visual-to-code-history.ts` | les types que les trois processus partagent |

**La migration n'est pas optionnelle.** Le store persiste en `version: 2` avec
un `migrate` qui transforme l'ancien diagramme unique en une première
architecture nommée. Quelqu'un qui avait un diagramme ouvert au moment de la
mise à jour doit le retrouver là où il l'a laissé — découvrir la fonctionnalité
en perdant son travail n'est pas une migration.

**L'historique est sur disque, pas dans `localStorage`.** Soixante instantanés
d'une architecture de quarante blocs, multipliés par le nombre de documents
ouverts, c'est des mégaoctets contre un quota d'environ 5 Mo que toute
l'application se partage — et un quota qui déborde lève à l'écriture, en
perdant silencieusement exactement le travail que la fonctionnalité existe pour
protéger. Un fichier par architecture sous
`userData/visual-to-code/history/<id>.json` : un instantané ne réécrit que le
document concerné, et supprimer une architecture supprime un fichier au lieu de
réécrire celui de tout le monde. Le fichier porte les corps, mais
`listVersions` ne renvoie que les métadonnées : le panneau dessine soixante
lignes, il n'a pas à recevoir soixante diagrammes pour ça.

**Une étape n'est pas une modification.** `signature` compte les positions —
déplacer un bloc est une édition, et l'annulation doit la reprendre.
`structuralSignature` les ignore, et c'est lui qui déclenche la capture : une
frise dont quarante lignes disent « bloc déplacé » est une frise que personne
ne parcourt. Les positions du moment voyagent quand même dans l'instantané de
l'étape suivante, donc rien n'est perdu. La capture est temporisée à 1,5 s,
bien au-delà des 350 ms de la pile d'annulation : celle-ci parle du dernier
geste, la frise parle de la forme d'un après-midi de travail.

**Restaurer ajoute, ne rembobine pas.** Les étapes postérieures à celle qu'on
restaure restent exactement où elles sont, et la restauration devient elle-même
la plus récente. Revenir voir mardi ne doit pas être le geste qui supprime
mercredi — et l'annulation d'une restauration n'est alors qu'une autre
restauration.

**Nommer une étape, c'est la conserver.** Le plafond de 60 ne compte que les
étapes anonymes ; une étape nommée est une décision, et un plafond n'a pas à
supprimer une décision. Les deux gestes sont un seul dans l'UI, parce que
demander les deux séparément reviendrait à regarder des étapes nommées tomber
du bas de la pile.

**Le miroir vers le store est regroupé (250 ms).** Un déplacement émet un
changement par frame, et le miroir écrivait chacun d'eux — ce qui re-rend
maintenant aussi la barre d'onglets. Tant que le canvas est monté, c'est *lui*
la vérité ; la copie du store existe pour survivre à la navigation et au
redémarrage. Ce qui rend le regroupement gratuit, c'est que les deux chemins
qui peuvent écourter la fenêtre — changer d'onglet, quitter la page — vident
d'abord (`flushMirror`). Un regroupement qui ne viderait pas serait une perte
de données déguisée en optimisation.

**`loadedArchitectureId` est un état, pas une ref**, et c'est tout l'argument de
correction : sur le rendu où le document actif change, le miroir s'exécute avec
le *nouvel* id et les *anciens* blocs. Une ref posée par le chargeur dans le
même commit se lirait déjà à jour, et le miroir écrirait les blocs d'un
document dans un autre.

## Le canvas en graphe de nœuds (`flow-canvas.css`, `FlowCard`, `DefaultEdge`)

Le canvas se dessine comme un graphe de nœuds : chaque bloc est une carte
(`FlowCard`) avec son rôle en petites capitales, dans sa couleur, au-dessus de
son nom ; les connexions sont des courbes (Bézier, plus des marches) avec un
halo, un trait et une lumière qui court dans le sens de l'interaction.

**Un bloc et un texte ne se ressemblent pas.** Un bloc est une surface pleine,
cadrée, avec un liseré de sa couleur à gauche. Ce qui est écrit sur un fil n'a
ni cadre ni surface : la relation est une étiquette ronde posée sur le fil, la
phrase est en italique libre, suspendue sous le fil, lisible sur la grille
grâce à un halo de la couleur du fond. Avec un cadre, les phrases se lisaient
comme des blocs de plus.

**Des jetons, pas le thème de l'app.** Tout se dessine depuis quelques
variables `--vtc-*` posées sur `.vtc-flow`. Le reste (cœur du trait, lumière,
lueur d'angle, texte secondaire) en est *dérivé* par `color-mix` dans la feuille :
une couleur de connecteur choisie recolore tout ce qui lui appartient. Ces
dérivées sont redéclarées sur `.vtc-tint`, parce qu'une propriété personnalisée
se calcule là où elle est déclarée : un fil qui a sa propre couleur doit
recalculer son cœur sur le fil.

**Le fichier redéclare l'ordre des couches** (`@layer theme, base, components,
utilities`). Il peut être chargé avant `globals.css` ; une couche nommée avant
celles de Tailwind passerait sous sa remise à zéro (cartes sans marge ni
bordure). Les règles qui surchargent ReactFlow sont hors couche : sa feuille
n'est pas dans une couche et gagnerait à toute spécificité.

**Thèmes par architecture** (`lib/canvas-themes.ts`, `CanvasThemePicker`). Un
thème est un préréglage plus les couleurs choisies à la main, qui gagnent ; il
est rangé sur l'architecture (`theme`), donc chaque document garde son allure.
Seules des couleurs `#rrggbb` sont gardées (`normalizeCanvasTheme`) : la valeur
finit dans un attribut `style`. Le préréglage « Thème de l'app » emprunte les
variables du thème de couleurs actif.

## Les briques personnalisées (`lib/custom-bricks.ts`, `stores/custom-bricks-store.ts`)

Une brique est un bloc que la personne s'est fait : nom, rôle affiché, couleur,
icône, technologie, description. C'est une **bibliothèque**, pas une partie
d'une architecture : la palette de toutes les architectures la propose. Store
séparé, parce que celui des architectures se re-rend à chaque fichier d'une
génération.

**Un bloc porte une copie de l'allure de sa brique**, pour qu'un diagramme
exporté, partagé ou dont la brique a été supprimée reste lisible.
`applyBricks` rafraîchit cette copie tant que la brique existe : c'est ce qui
est dessiné, mis dans la spec, généré et exporté (`liveNodes`). Le nom et la
technologie d'un bloc restent les siens. Tout ce qui revient du stockage
repasse par `normalizeBrick` (nom requis, longueurs bornées, icône connue,
couleur hexadécimale).

## Les explications des interactions (`explainConnection`)

Chaque connexion porte sa relation (« lit / écrit ») et une phrase. La phrase
est écrite par le canvas depuis les deux blocs (`EXPLAIN` dans
`architecture-connections.ts`, une par relation, testé) **tant que la personne
n'a pas écrit la sienne** (`data.description`). Garder la phrase automatique
comme texte figerait les noms : renommer un bloc ne la mettrait plus à jour.
C'est pourquoi l'éditeur ne stocke un texte que s'il diffère de l'automatique,
et qu'un texte vidé revient à l'automatique. Les deux partent dans la
spécification de build, une ligne par connexion.

**Écart de colonnes de 520 px** (`canvas-layout.ts`) : une carte (jusqu'à
280 px) plus la phrase posée sur ses fils (jusqu'à 240 px) ; plus serré, la
phrase tombe sur la carte suivante.
