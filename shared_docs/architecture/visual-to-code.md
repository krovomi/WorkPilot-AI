# Visual-to-code : architectures et historique

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
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
