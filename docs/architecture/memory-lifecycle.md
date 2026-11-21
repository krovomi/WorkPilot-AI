---
feature: Cycle de vie de la mémoire et conflits d'équipe
summary: >-
  Chaque décision sur la mémoire d'un projet est une ligne d'un journal Markdown rangé dans le
  vault (fusionné par union), l'oubli est une corbeille restaurable 30 jours, l'épingle bat toute
  automatisation, et une synchronisation qui apporte une note contradictoire la règle par des
  règles sûres et déterministes ou la met en file pour une personne.
---

# Le cycle de vie de la mémoire, expliqué (#348) — et les conflits d'équipe (#352)

La mémoire des builds est le vault (`brain/project_memory.py`, voir [brain.md](brain.md)).
`forget()` faisait un `unlink` : l'historique git du vault était la seule trace, et personne ne
lit `git log` pour savoir pourquoi l'app a cessé de savoir quelque chose. Et quand deux
coéquipiers synchronisaient deux notes contraires (« toujours lancer les migrations avant les
tests » / « ne jamais… »), les deux restaient, et chaque agent suivait celle qu'il lisait en
premier. `brain/lifecycle/` répond aux deux.

Les issues ont été écrites pour Graphiti, retiré depuis (TTL, LRU, compression d'un graphe). Il
n'y a pas d'éviction automatique dans le vault : les seules suppressions automatiques sont celles
du learning loop (un pattern retiré) et, désormais, l'archivage d'une variante par une
synchronisation. Le lot 1 porte donc sur ce qui existe : journal, corbeille, épingles, conflits.

## Où tout vit

```
knowledge/projects/<projet>/memory/
  gotchas/ patterns/ codebase/ outcomes/ sessions/    les mémoires (inchangé)
  .lifecycle/journal/<AAAA-MM>.md                     le journal, un fichier par mois
  .lifecycle/forgotten/<dossier>/<slug>.md            la corbeille (frontmatter `lifecycle:`)
  .lifecycle/archived/<dossier>/<slug>--<date>.md     les variantes écartées, liées à la canonique
<cerveau>/.workpilot-brain/conflicts.json             la file « à trancher » de cette machine (ignorée par git)
```

**Dans le vault, donc synchronisé.** Le journal, la corbeille et l'archive voyagent avec les notes :
un coéquipier voit pourquoi une mémoire a disparu, et une décision prise sur une machine
s'applique sur l'autre au prochain pull.

**Caché, donc jamais rappelé.** `.lifecycle/` commence par un point : `notes.iter_notes`, le
graphe, `brain_recall` et `ProjectMemory._notes` l'ignorent. Un agent qui demande « que sait-on
de X » ne doit pas recevoir l'aperçu d'une mémoire qu'une personne a oubliée. Obsidian ne liste
pas non plus le dossier : le journal se lit dans l'app (onglet **Cycle de vie**) ou dans
n'importe quel éditeur.

## Le journal (`journal.py`)

Une ligne par décision, une phrase pour la personne et l'entrée en JSON dans un commentaire HTML
en fin de ligne pour l'app (Obsidian le masque en lecture) :

```
- 2026-11-14 10:02 UTC — oubliée par la personne : `gotchas/x.md` « Titre » — Obsolète. <!-- wp-lifecycle {...} -->
```

- **Fusionné par union.** Deux machines qui ajoutent au même fichier ajoutent toutes deux à la fin :
  un merge ligne à ligne est en conflit à chaque fois, et la bonne réponse est toujours « garder les
  deux lignes ». `sync.ensure_attributes` écrit
  `knowledge/projects/*/memory/.lifecycle/journal/*.md merge=union` dans `.git/info/attributes`
  (le pilote `union` est intégré à git, rebase compris) : pas de `.gitattributes` à la racine
  d'un vault adopté, et chaque machine qui synchronise par WorkPilot passe par là.
  Le fichier mensuel est la rotation demandée par l'issue.
- **Des codes, pas de la prose, décident.** `action`, `actor` et `reason_code` viennent de listes
  fermées (`ACTIONS`, `ACTORS`, `REASONS`) que l'UI traduit ; un acteur inconnu devient `agent`.
  `reason` est du texte libre (les mots d'une personne, `timeout: 30 ≠ 60`), expurgé comme tout
  texte du vault et seulement affiché. Un `>` est échappé dans le JSON : une raison qui contient
  `-->` ne ferme pas le commentaire.
- **Une création, ou un texte qui change.** `ProjectMemory._write` journalise la création d'une
  note et une mise à jour **dont le texte change** : le learning loop réécrit ses compteurs à
  chaque prompt (`record_application`), et un journal qui le noterait serait illisible. Une fusion
  de patterns similaires (`PatternStorage.add_patterns`) est dite comme telle (`merge`,
  `similar-merged`, l'instruction fusionnée en raison), par `ProjectMemory.explain_next`.
- **L'acteur** est porté par `ProjectMemory.actor` : `agent` par défaut, `learning-loop` pour
  `PatternStorage`, `user` pour l'API et la suppression d'un pattern depuis le desktop, `sync`
  pour l'arbitrage, `lifecycle` pour la purge.

## Corbeille, restauration, épingles (`store.py`)

- **Oublier, c'est déplacer.** La note part, intacte, dans `.lifecycle/forgotten/` avec
  `lifecycle: {forgotten_at, forgotten_by, reason_code, reason, restore_until}`.
  `BRAIN_MEMORY_RETENTION_DAYS` (30) jours, trois fois plus pour une note épinglée (le cas
  « suppression accidentelle d'une mémoire critique » de l'issue). Après, elle est purgée à la
  prochaine lecture du cycle de vie, et le journal le dit (`purge`, `retention-expired`).
- **Annoncer avant de supprimer.** La corbeille marque `expiring_soon` ce qui sera purgé dans les
  7 jours, et l'onglet l'annonce.
- **Restaurer** remet la note à sa place, sans `lifecycle:`. Refusé si une note du même nom a été
  réécrite depuis (`exists`) : écraser la mémoire actuelle avec l'ancienne serait une seconde perte.
  Si la note restaurée contredit une mémoire vivante (le détecteur ci-dessous), la réponse le dit :
  c'est l'avertissement « cette mémoire contredit l'état actuel » de l'issue, sur le seul état que
  le vault connaît.
- **L'épingle bat toute automatisation, jamais la personne.** `pinned: true` dans le frontmatter
  (gardé par `Brain.write`, qui conserve le frontmatter existant), au plus `PIN_LIMIT` (50) par
  projet. Un oubli par un autre acteur que `user` est refusé et journalisé (`protect`,
  `pinned-protected`) : « le pin gagne toujours, on le journalise par transparence ».
- **Chaque id est vérifié avant d'ouvrir un fichier** (`memory_rel`) : un dossier de mémoire
  (liste fermée), un `.md`, aucun segment caché ni `..`, dans la mémoire de *ce* projet, puis
  `notes.inside`. Le main Electron fait le même contrôle avant d'appeler le backend
  (`memory-lifecycle-validation.ts`).

## Reprendre une décision (`undo.py`)

Le journal dit pourquoi une mémoire est partie ; la personne peut répondre « non ».

| Entrée du journal | Reprise | Proposée |
|---|---|---|
| `forget` par une automatisation (un agent, le learning loop) | la note revient de la corbeille | dans l'heure (`UNDO_WINDOW`) : **Annuler** |
| `archive` par une automatisation (un arbitrage de synchronisation) | la variante revient et la paire attend une personne | dans l'heure : **Annuler** |
| `archive`, quel que soit l'auteur | la même chose, sans limite | tant que la variante est à l'archive : **Séparer** |

- **Annuler la dernière décision automatique** est un bandeau en tête de l'onglet (l'entrée la
  plus récente de l'heure encore annulable) ; chaque entrée reprenable du journal a son bouton.
- **Séparer, c'est la dé-fusion manuelle de l'issue.** Une note de consensus (`source:
  team-consensus-…`, écrite par une personne à partir de deux variantes) se sépare en entier :
  elle part à la corbeille (restaurable), les deux variantes reviennent, la paire revient dans la
  file. Une autre note canonique reste ; la variante revient à côté, et la paire est remise dans la
  file (`arbitration.requeue`, qui la retire de la liste « pas un conflit ») puisque les deux
  notes se contredisent toujours. Une place reprise depuis (une paire textuelle dont l'autre
  version a pris le nom de la note) fait revenir la variante en copie de conflit à côté.
- **Une entrée se reprend une fois** : la reprise est un `restore` (raison `undone` ou
  `unmerged`) qui porte l'id de l'entrée reprise (`undoes`). Un oubli par la personne se restaure
  depuis la corbeille, pas ici ; une purge a supprimé la note ; une fusion du learning loop a plié
  un pattern qui n'a jamais été une note à lui, donc rien à séparer. L'id reçu est vérifié deux
  fois (12 caractères hexadécimaux dans le main, entrée du journal de *ce* projet dans le backend),
  et le chemin que l'entrée nomme passe par `memory_rel` comme tout id.

## Les chiffres (`metrics.py`)

Lus dans le journal, rien n'est envoyé : restaurations et annulations de la semaine (beaucoup
veut dire que les automatisations retirent trop, et l'onglet le dit à partir de
`AGGRESSIVE_RESTORES`, 5), retraits automatiques, taux d'épingles, conflits des 30 derniers jours
réglés par les règles ou par une personne, temps moyen avant qu'une personne tranche, et le
nombre d'historiques ouverts (« pourquoi ? »). Ce dernier est compté par machine
(`.workpilot-brain/lifecycle-views.json`, ignoré par git) : le compter dans le vault ferait de
chaque lecture un commit.

## Après une synchronisation : les contradictions (`contradictions.py`, `arbitration.py`)

`sync._pull` rapporte désormais les notes que le pull a ajoutées ou changées (`received`,
`git diff --diff-filter=AM` entre la tête d'avant et celle d'après). `Brain.sync` et
`Brain.before_read` passent ces notes et les conflits textuels à `arbitration.review_pull`.

**Deux sortes de paires.** Un conflit **textuel** est une note modifiée sur deux machines
(`_keep_both` a gardé `x.md` et `x.conflict-<sha>.md`) ; une paire **sémantique** est une note
reçue de `gotchas/` ou `patterns/` que le détecteur trouve contraire à une note vivante du même
projet et du même dossier.

**Le détecteur est déterministe**, sans modèle, hors ligne, identique pour tous les fournisseurs —
donc deux coéquipiers jugent la même paire de la même façon. Il compare la *déclaration* d'une
note (sans `## Liens`, sans les lignes en italique comme le pied du learning loop, sans les
étiquettes en gras) et demande le même sujet (assez de mots en commun) plus un signal :

| Signal | Exemple |
|---|---|
| `value` | le même réglage avec deux valeurs : `retries = 3` / `retries = 5`, « timeout to 30 seconds » / « 60 seconds » |
| `recommendation` | le même verbe recommande deux choses dans le même contexte : « use Prisma for billing » / « use Drizzle for billing » |
| `negation` | l'une dit de le faire, l'autre non : « always … » / « never … », « toujours … » / « ne jamais … » |

La précision passe avant le rappel : une fausse alerte coûte un clic, une alerte manquée laisse les
choses comme avant. Deux notes dont les `applies_to` diffèrent ne sont jamais comparées (« sur
`auth/` on fait ainsi, sur `payments/` autrement » — le début des « branches de mémoire » de
l'issue) ; « use X » contre « don't use Y » est un conseil complémentaire ; deux déclarations
identiques ne sont pas un conflit. Marqueurs anglais et français ; le code dont parle une note peut
être de n'importe quel langage, seule sa prose est lue.

**Règles sûres, dans l'ordre :**

| Règle | Gagnant |
|---|---|
| `same-statement` | deux versions d'une note qui disent la même chose (un pattern dont les compteurs ont divergé) : la nôtre, les preuves fusionnées (le plus grand compteur, toutes les sources) |
| `pinned-wins` | la note épinglée, quand une seule l'est |
| `higher-confidence` | deux patterns du learning loop à `CONFIDENCE_GAP` (0,2) d'écart : le plus sûr |
| `more-recent` | deux notes différentes, l'ancienne pas touchée depuis `BRAIN_CONFLICT_STALE_DAYS` (30) jours avant la nouvelle : la nouvelle |

« La plus récente gagne » sans condition ne laisserait rien à trancher à personne : deux notes
écrites la même semaine sont exactement le cas où il faut demander. La perdante est archivée,
liée à la gagnante (`lifecycle.canonical` d'un côté, `variants:` de l'autre), journalisée par
`sync`. Ce qui a été archivé est committé par la synchronisation suivante.

**Sinon, la file.** La personne voit les deux notes côte à côte (texte, auteurs, date, épingle,
confiance) et garde l'une, **écrit la note canonique** (`source: team-consensus-<date>`, les deux
variantes archivées et liées), ou dit **pas un conflit** (la paire n'est plus signalée sur cette
machine). Chaque choix est journalisé (`resolve`).

**La file est celle de la machine** (`.workpilot-brain/conflicts.json`, ignoré par git) : deux
machines qui signaleraient la même paire en même temps seraient en conflit sur la file elle-même.
La décision, elle, est dans le vault : la note canonique, les variantes archivées et le journal
arrivent chez le coéquipier au prochain pull, et une paire réglée ailleurs sort de sa file.

## Les règles d'une équipe : qui a tranché, l'oscillation, les mainteneurs, la portée

- **Qui a tranché** (`identity.py`). Une décision d'une personne porte son nom (`by`), celui
  de l'identité git du vault — celle que ses commits portent déjà. C'est l'« historique des
  consensus » de l'issue : la carte **Décisions** de l'onglet liste les `resolve` avec leur
  auteur. L'e-mail ne sert qu'à reconnaître un mainteneur, il n'est jamais écrit.
- **Une paire qui oscille est escaladée** (`arbitration.earlier_decision`). Une paire tranchée
  il y a moins de `BRAIN_CONFLICT_COOLDOWN_DAYS` (7) jours — par une personne ou par une règle,
  les deux notes nommées par la même décision, une copie de conflit comptant pour sa note — qui
  se contredit de nouveau n'est plus réglée par une règle : elle entre dans la file marquée
  `escalated` (date, auteur et raison de la décision renversée), et le journal le dit
  (`conflict`, `escalated`). Deux versions fusionnées parce qu'elles disaient la même chose ne
  sont pas une décision qu'on renverse.
- **Les mainteneurs** (`maintainers.py`) sont une liste du vault,
  `.lifecycle/maintainers.md`, une ligne par nom ou e-mail (20 au plus), modifiée depuis
  l'onglet et journalisée (`designate`). Une paire escaladée n'est tranchée que par l'un d'eux
  (`maintainer-only` sinon, et l'UI désactive ses boutons) ; sans liste, par n'importe qui.
  C'est une règle d'équipe, pas un contrôle d'accès : quiconque écrit dans le vault peut changer
  la liste ou son nom git, et le journal le montre.
- **La portée d'une mémoire** (`store.scope`) : **Portée** sur chaque mémoire écrit son
  `applies_to` (une ligne, 200 caractères au plus ; vide = partout), que le détecteur respecte
  déjà. C'est la « branche de mémoire » par module de l'issue.

## L'avis d'un modèle (`advisor.py`), demandé par une personne

Sur une paire de la file, « Demander au modèle » envoie *cette paire seulement* au fournisseur
choisi par la personne, par le port `agent_runtime` (`oneshot_completion`, donc les fabriques de
`core.client` et leur garde hors-ligne `offline_policy.guard_cloud_client` sur le dossier du
projet ; Ollama compris). Les deux notes viennent d'un coéquipier ou d'un agent, par git : du
contenu externe, nettoyé et délimité par `security.untrusted.quote_untrusted` avant d'entrer dans
le prompt. La réponse est lue dans une forme fermée (`verdict` parmi `contradiction`,
`complementary`, `duplicate` ; `prefer` parmi `a`, `b`, `none` ; textes plafonnés et expurgés),
affichée, et proposée comme brouillon de note canonique que la personne modifie et enregistre.
Le modèle ne tranche jamais.

C'est pourquoi le contrat d'imports de `brain` s'élargit à `agent_runtime` (une feuille) et
`security` (`clean_untrusted`) : aucun des deux ne remonte vers `brain`, le plus grand cycle ne
change pas.

## Surfaces

- `GET /api/brain/memory/lifecycle` (avec les entrées reprenables et les chiffres),
  `GET …/history`, `POST …/forget`, `…/restore`, `…/pin`, `…/revert`, `…/scope`, `…/maintainers`,
  `…/conflicts/resolve`, `…/conflicts/suggest` (`brain/lifecycle/api.py`, inclus dans le routeur
  du cerveau : refusé en mode serveur comme lui, le projet est un nom lu dans `project_dir`).
- Desktop : canaux `CONTEXT_MEMORY_*` (`main/ipc-handlers/context/memory-lifecycle-handlers.ts`,
  chaque argument revalidé), onglet **Cycle de vie** de la vue Contexte
  (`components/context/lifecycle/`), et Épingler / Oublier / Historique sur chaque mémoire de
  l'onglet Mémoires. Un projet du serveur n'a pas encore ces actions.

## Ce qui reste (lots suivants)

- Projets du serveur : servir le cycle de vie par `/api/features/context/…` avec ses permissions.
- Dé-fusion d'un pattern que le learning loop a plié dans un autre : le pattern plié n'est pas
  gardé à part (seule son instruction est dans le journal) ; il faudrait que le learning loop le
  conserve avant de le fusionner.
- Notifications d'équipe (Slack, Teams, e-mail) quand un conflit est détecté : les canaux
  existent (`services/notifications/`), mais la configuration d'un webhook est celle d'un projet
  et le vault est commun à tous ; à brancher et à vérifier avec un compte Slack ou Teams réel,
  qu'on n'a pas ici.
- Mainteneurs par module (une liste par `applies_to`) pour une grande équipe ; portées par équipe
  ou par branche git, que les notes ne portent pas encore.
- Embeddings locaux pour rapprocher deux formulations équivalentes : une dépendance lourde
  (modèle de phrases à télécharger) à justifier ; signature des instantanés et liste blanche des
  sources : demande une clé par coéquipier et sa distribution (aujourd'hui, la confiance est
  celle du distant git choisi).
