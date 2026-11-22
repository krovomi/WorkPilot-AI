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
  .lifecycle/folded/patterns/<id>--<date>.md          les patterns qu'une fusion du learning loop a pliés (30 jours)
<cerveau>/.workpilot-brain/conflicts.json             la file « à trancher » de cette machine (ignorée par git)
<cerveau>/.workpilot-brain/projects.json              où vit chaque projet de cette machine (ignoré par git)
<cerveau>/.workpilot-brain/announced.json             les paires annoncées d'ici à l'équipe (ignoré par git)
<cerveau>/.workpilot-brain/embeddings.json            les vecteurs du modèle d'embeddings local, par note (ignoré par git)
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
| `merge` de deux patterns par le learning loop | le pattern plié redevient le sien, sa part retirée de l'autre (`folds.py`) | dans l'heure : **Annuler** ; puis tant que le pli est gardé (30 jours) : **Séparer** |

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
  depuis la corbeille, pas ici ; une purge a supprimé la note. L'id reçu est vérifié deux
  fois (12 caractères hexadécimaux dans le main, entrée du journal de *ce* projet dans le backend),
  et le chemin que l'entrée nomme passe par `memory_rel` comme tout id.

## Séparer une fusion du learning loop (`folds.py`)

Le learning loop plie un nouveau pattern dans un pattern semblable qu'il connaît
(`PatternStorage.add_patterns`) : occurrences ajoutées, confiance relevée, builds et étiquettes
ajoutés. Le pattern plié n'était jamais écrit : le journal expliquait la fusion, rien ne la
reprenait. Il est maintenant gardé, tel que la note qu'il aurait été, dans
`.lifecycle/folded/patterns/`, avec ce qu'il a apporté (`lifecycle.share` : occurrences, les
builds et étiquettes que lui seul a apportés, le pas de confiance `MERGE_BOOST`), et l'entrée
`merge` du journal le nomme (`related`).

- **Séparer** le remet à sa place comme pattern à lui et retire sa part du pattern canonique.
  Le relèvement de confiance est le même pas affine `c ↦ c + (1 − c)·b` à chaque fusion : ces pas
  commutent, donc en retirer un donne la confiance qu'aurait le pattern sans *cette* fusion, même
  après d'autres. Le pied du pattern (« confiance 0,66, vu 5× ») est réécrit avec.
- **Annuler** dans l'heure, comme toute décision automatique : la fusion est alors la dernière
  décision du bandeau.
- **Gardé 30 jours** (`BRAIN_MEMORY_RETENTION_DAYS`) : le learning loop fusionne à chaque build,
  et une fusion que personne n'a contestée en un mois est l'histoire du pattern, pas une décision
  à reprendre. Ensuite le pli est supprimé sans ligne de journal (l'entrée `merge` reste ; le pli
  n'a jamais été une mémoire), à la lecture du cycle de vie.
- Un pattern revenu depuis sous le même id n'est pas écrasé (`exists`) ; un pattern plié dans
  lui-même (le même id revu) n'est pas un pli.

## Un projet du serveur (`shared_features/context_lifecycle.py`)

La mémoire d'un projet du serveur est son propre cerveau, sur le serveur
(`run_isolation.project_brain`), que chaque run du projet alimente et que chaque membre lit. Les
mêmes décisions y sont servies sous `/api/features/context/memory/*`, avec les permissions du
serveur :

| Route | Permission |
|---|---|
| `GET …/lifecycle`, `GET …/history` | `insight.read` : chaque membre lit pourquoi une mémoire est partie |
| `POST …/forget`, `…/restore`, `…/pin`, `…/scope`, `…/revert` | `insight.write` |

**Qui décide pour l'équipe.** La mémoire est celle de l'équipe, une décision sur elle aussi :
quiconque peut écrire les insights du projet (contributeur, analyste, mainteneur, administrateur)
oublie, épingle, restaure ou reprend une décision automatique, et le journal le nomme (`by`, son
nom d'affichage ; l'e-mail n'est jamais écrit, `identity.acting_as`). Un lecteur lit et ne décide
rien. Il n'y a pas de permission à part : forget, pin et undo sont réversibles et journalisés, et
les insights sont déjà le domaine où l'on écrit ce que l'équipe sait.

- **Aucune commande git** dans un cerveau que les runs du projet écrivent : la personne vient de
  la session, pas de `git config`, et rien n'est commité par la route.
- **Le cerveau reste dans le home du projet** : un cerveau qu'un run aurait remplacé par un lien
  vers un autre dossier n'est pas servi (`no-brain`).
- **Expurgé à la lecture** : journal et corbeille passent par `redact_text`, comme les mémoires.
- **Pas de file de conflits** : elle suit une synchronisation git entre les vaults de coéquipiers,
  et le cerveau d'un projet du serveur n'est jamais synchronisé. L'onglet le dit à la place de la
  section ; conflits, mainteneurs et avis du modèle répondent `server-project`.

Côté desktop, `memory-lifecycle-target.ts` envoie l'appel au backend de la machine (projet local,
nommé par son chemin) ou au serveur (projet du serveur, nommé par son id, avec le jeton de la
session) ; les deux répondent la même forme.

## Les chiffres (`metrics.py`)

Lus dans le journal, rien n'est envoyé : restaurations et annulations de la semaine (beaucoup
veut dire que les automatisations retirent trop, et l'onglet le dit à partir de
`AGGRESSIVE_RESTORES`, 5), retraits automatiques, taux d'épingles, conflits des 30 derniers jours
réglés par les règles ou par une personne, temps moyen avant qu'une personne tranche, et le
nombre d'historiques ouverts (« pourquoi ? »), les notes de consensus écrites en 30 jours
(`create` / `person-wrote`) et celles encore en usage (notes vivantes dont la `source` est
`team-consensus-…` : ni oubliées ni remplacées), les deux chiffres de l'issue qu'une machine
peut compter seule (son « taux d'adoption » passait par les analytics du reviewer, qui ne
lisent pas la mémoire). Le nombre d'historiques est compté par machine
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
- **Des mainteneurs par portée**, pour une équipe trop grande pour une liste : un titre
  `## <portée>` du même fichier ouvre la liste d'un module, d'une équipe ou d'une branche (50
  au plus), et la section la plus précise qui couvre la portée de la paire l'emporte
  (`apps/` couvre `apps/billing/`, `branch:release/` couvre `branch:release/2.0`, `team:pay` ne
  couvre pas `team:payments`) ; une paire qu'aucune section ne couvre revient à la liste du
  haut. La portée d'une paire est lue dans ses notes au moment de trancher (celle qu'elles
  partagent, sinon celle qui est posée) ; chaque paire escaladée de la vue porte ses
  mainteneurs et si la personne ici en est (`arbitration.with_maintainers`). `POST
  …/maintainers` prend une `scope` facultative ; une liste de portée vide disparaît. Un titre
  qui ne nomme pas une portée lisible est ignoré avec ses noms : une liste ne s'applique jamais
  là où personne ne l'a voulue.
- **La portée d'une mémoire** (`store.scope`, `scopes.py`) : **Portée** sur chaque mémoire
  écrit son `applies_to` (une ligne, 200 caractères au plus ; vide = partout), que le détecteur
  respecte. Trois formes, que le champ suggère :

  | Forme | Exemple | Pour |
  |---|---|---|
  | un module | `apps/billing/` | une partie du code (tout texte, comme avant) |
  | `team:<nom>` | `team:paiements` | la façon de faire d'une équipe |
  | `branch:<nom>` | `branch:release/2.0` | une branche git, une ligne de version |

  Le préfixe s'écrit en minuscules sans espace après les deux-points (`Team: Paiements` et
  `team:paiements` sont une seule portée, comparée sans casse) ; un nom de branche suit les
  règles d'une ref git (ni espace, ni `..`, ni `~^:?*[\`), pour qu'une faute de frappe soit
  refusée plutôt que de ne rien couvrir. C'est la « branche de mémoire » de l'issue, par
  module, par équipe ou par branche : deux notes de portées différentes ne se contredisent
  jamais. La portée sépare les conflits, désigne les mainteneurs et filtre ce qu'un agent
  rappelle (ci-dessous).
- **Ce qu'un agent rappelle d'une note portée** (`scopes.recalled`, un seul filtre pour les
  trois chemins de rappel) :

  | Portée | Rappelée pour |
  |---|---|
  | aucune, ou un module | tout build, comme avant |
  | `branch:<nom>` | un build dont la branche git est celle-là, ou en dessous à un `/` (la règle de `covers` : `branch:release` sert `release/2.0`, pas `release-2.0`) ; jamais quand la branche ne se lit pas (pas de dépôt, HEAD détachée) |
  | `team:<nom>` | en local (desktop, CLI), tout build, comme avant ; en mode serveur, un run lancé par un membre du groupe de ce nom (sans casse) |

  La branche est celle du worktree de la tâche, lue par `git symbolic-ref` (`foundation`, liste
  d'arguments). Les trois chemins : la mémoire du projet qu'ouvrent les agents
  (`memory.store.get_project_memory`, `open_project_memory`, les indices de
  `get_graph_hints` et leur complément pris dans tout le vault), les outils `brain_recall` et
  `query_graph` du serveur `workpilot-brain` (sa config reçoit la branche du build,
  `WORKPILOT_BRAIN_BRANCH` ; lancé par l'agent d'une personne, il lit celle du dossier où il
  tourne ; dans le processus, `tool_executor` passe le dossier du build), et `mem_search`
  (`BrainSource`). Un run du serveur reçoit les groupes de la personne qui l'a lancé dans
  l'organisation du projet (`WORKPILOT_RECALL_TEAMS`, liste JSON posée par `run_manager`, `[]`
  sans groupe ; la valeur du serveur n'est jamais transmise), et sa présence seule dit « mode
  serveur ». Les surfaces d'une personne (onglet Mémoires et sa recherche, Cycle de vie,
  historique, la visite d'onboarding) montrent toujours chaque note avec sa portée ; une
  écriture relit toutes les notes. C'est un filtre de pertinence, pas un secret : un run lit le
  cerveau de son projet sur le disque. `get_node` et `brain_read_note` ouvrent ce que l'agent
  nomme, sans filtre.

## Le dire à l'équipe (`announce.py`), sur demande

Quand une synchronisation met une paire en file, les auteurs des deux notes l'apprennent là où
l'équipe parle déjà : les canaux du projet pour « PR prête » (Teams, Slack, Discord, Google
Chat, webhook, `services/notifications/`). Rien sans `WORKPILOT_MEMORY_CONFLICT_NOTIFY=true`
(l'environnement du processus, sinon le `.workpilot/.env` du projet ; l'interrupteur est dans
Réglages du projet → Notifications) ni sous la politique hors ligne stricte (une politique
illisible compte comme stricte) : les notes sont le savoir du projet, un webhook est un nuage.

- **Un port, pas un import.** Les canaux et leur garde SSRF (`channels.post_json` : adresse
  publique `http`/`https` résolue, pas de redirection) vivent dans `services`, qui est dans le
  cycle d'imports des agents ; `brain` n'y entre pas. `services/notifications/__init__.py`
  installe donc l'expéditeur (`memory_conflicts.ChannelAnnouncer`) dans chaque processus qui
  charge les notifications (l'API, un build ; le runner du cerveau les charge pour cela). Un
  processus sans expéditeur n'annonce rien, et le suivant qui en a un le fait : ce qu'il
  annonce est « ce qui est en file ici et n'a pas été annoncé ».
- **Quel projet.** Le vault est commun à tous les projets de la machine et la file nomme une
  mémoire (`knowledge/projects/<slug>/memory`), pas un dossier ; les webhooks sont ceux d'un
  projet. Chaque `ProjectMemory` qui lit le vault écrit où vit son projet
  (`.workpilot-brain/projects.json`, le worktree d'une tâche ramené à son projet) ; une entrée
  n'est crue que si le dossier existe encore, est absolu, et est bien le projet que la mémoire
  nomme.
- **Ce qui part.** Le nom du dossier du projet, le genre de note et le signal (listes fermées),
  et pour chaque note son titre, un aperçu de 200 caractères et ses auteurs. Les auteurs sont
  les noms git des commits qui ont touché la note (au plus trois, sans l'identité de repli
  « WorkPilot Brain », sans un nom qui contient un `@` : jamais une adresse) ; pour une copie de
  conflit, celui de la version distante. Le texte est celui d'un coéquipier (règle S2) : passé
  par `clean_untrusted`, expurgé, sur une ligne, avec `<`, `>` et `@` remplacés pour qu'il ne
  mentionne personne (`@here`, `<!channel>`) ; Discord reçoit en plus `allowed_mentions` vide.
  Un texte que le scanner d'injection signale est retenu (« texte retenu »), pas envoyé.
- **Jamais deux fois.** Une paire est réservée dans `.workpilot-brain/announced.json` (verrou
  par fichier, `foundation.json_ledger`) avant l'envoi et libérée si aucun canal ne l'a prise :
  elle sera retentée au prochain pull. Une réservation qui ne peut pas s'écrire n'envoie rien.
  Dès qu'un canal l'a prise, une ligne `notify` (`conflict-announced`) va au journal du vault :
  le coéquipier dont la synchronisation met la même paire en file la voit après son prochain
  pull et ne l'annonce pas. Deux machines qui annoncent dans la même minute, avant tout pull,
  peuvent encore le dire chacune une fois.
- **Hors du fil de l'appelant.** `Brain._review_pull` lance le balayage dans un fil à lui
  (pas un démon : le processus attend la fin, chaque canal est borné par son délai) ; un
  balayage à la fois par processus. Un message liste au plus trois paires, puis « et N de
  plus », dans la langue de l'app ; le webhook générique reçoit aussi les paires en JSON
  (`event: memory_conflict`).

Vérifié contre un serveur HTTP local (`tests/services/test_memory_conflict_notices.py`), pas
contre un vrai compte Slack ou Teams : les formats de message sont ceux que les canaux
reçoivent déjà pour « PR prête » et le test de webhook.

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

## Des notes vérifiées par la signature git (`signers.py`, `provenance.py`)

Le vault voyage par un distant git : quiconque peut y pousser met une note devant chaque agent de
l'équipe, et « la confiance est celle du distant » ne suffit pas à une équipe qui veut plus. Les
clés sont celles que chacun a déjà pour signer ses commits git (SSH ou GPG) : aucune clé à créer,
à distribuer ni à garder par WorkPilot.

- **Signer.** `sync._commit` laisse git signer quand la configuration de la personne le dit
  (`commit.gpgsign`, `gpg.format`, `user.signingkey`) ; rien ne l'active, rien ne crée de clé.
  Une clé hors de portée (pas d'agent, fichier disparu) ne bloque pas le cerveau : le commit part
  sans signature, avec un avertissement dans le journal du processus, et l'équipe voit la note
  non vérifiée.
- **La liste** est un fichier du vault, à côté des mainteneurs :
  `.lifecycle/trusted-signers.md`, une ligne `- <nom> <clé>` par clé (clé publique SSH
  `<type> <base64>`, ou empreinte GPG de 40 ou 64 chiffres hexadécimaux), 50 au plus. Elle se
  modifie depuis l'onglet (**Signataires de confiance**), est journalisée (`designate`,
  `signers-changed`) et, comme une paire escaladée, n'est modifiée que par un mainteneur quand le
  projet en a (`maintainer-only`).
- **Le verdict de chaque note.** Après une synchronisation, à la lecture, la dernière
  modification de chaque note du dossier du projet (`knowledge/projects/<projet>/`) est attribuée
  à son commit (`git log --name-only`, les merges mis à part) et sa signature lue par git
  lui-même (`%G?`, `%GF` : la mécanique de `git verify-commit`, `gpg.ssh.allowedSignersFile`
  pointé par `-c` sur les clés SSH de la liste, `gpg.ssh.program` sur le `ssh-keygen` du système,
  un programme qui ne sait que signer ne vérifiant pas). Arguments en liste, sans shell.

  | Verdict | Quand |
  |---|---|
  | `own` | écrite ici et pas encore synchronisée : un changement sur le disque, ou un commit qu'aucun distant n'a |
  | `verified` | son dernier commit est signé, signature bonne (`G`, `U`), par une clé dont l'empreinte est sur la liste |
  | `unverified` | tout le reste : sans signature, une autre clé, une signature que git ne peut pas vérifier (clé GPG absente du trousseau), une copie de conflit (le texte de l'autre côté) |

- **Lisible, pas injectée.** Une note non vérifiée reste lisible là où une personne lit la
  mémoire, avec la marque « non vérifiée » : onglet Mémoires (et sa recherche), historique d'une
  mémoire, journal de l'onglet Cycle de vie (qui compte aussi ces notes), `POST /api/brain/recall`.
  Elle n'arrive à aucun agent : `ProjectMemory` la saute (pièges, conventions, sessions, recherche,
  indices du graphe), `Brain.recall` la laisse de côté et `Brain.read` retient son texte et son
  frontmatter, le serveur MCP `workpilot-brain` fait de même et retire ses nœuds de
  `query_graph` / `get_node`, `mem_search` ne l'indexe pas, et le learning loop ne met pas ses
  patterns dans un prompt (`get_patterns_for_phase`) tout en les gardant dans son magasin, qu'il
  réécrit. Aucune règle automatique ne tranche une paire dont une note est non vérifiée (son
  épingle ou sa date sont la parole de son auteur) : elle attend une personne.
- **La liste se protège elle-même.** Une modification poussée par quelqu'un d'autre ne compte
  que si une clé déjà sur la liste l'a signée ; la première liste d'un projet ouvre l'opt-in telle
  quelle. Sinon, quiconque peut pousser une note pourrait aussi pousser une liste à sa clé, ou une
  liste vide. La modification de la personne (sur le disque, ou un commit qu'aucun distant n'a)
  compte toujours ; l'onglet dit combien de modifications reçues ont été écartées. L'éditeur part
  de la liste en vigueur, pas du fichier : enregistrer ne valide pas une modification écartée.
- **Opt-in, par projet.** Sans liste, ou avec une liste vide, rien ne change : aucune note n'a de
  verdict et toutes vont aux agents comme avant. Un cerveau qui n'a jamais rien reçu (aucune
  référence distante) n'exécute même pas git pour le savoir. Quand la liste existe mais que git ne
  répond pas, rien de reçu ne va aux agents (échec fermé).
- **Ce qui n'est pas couvert.** Une note hors du dossier d'un projet (le reste du vault, les
  instructions partagées) n'est couverte par aucune liste. Un commit local, ou une fusion, posé
  sur une modification reçue s'en porte garant, comme un commit signé en git. Les projets du
  serveur n'ont pas de liste : leur cerveau n'est jamais synchronisé, et aucune commande git n'y
  est lancée depuis une route.
- **Le cache** des signatures est celui de la machine : `.workpilot-brain/signatures.json`
  (ignoré par git), par commit : `G`, `U` (bonne signature, clé connue ou non) et `N` (aucune).
  Le verdict est recalculé à partir de ces faits et de la liste du moment : retirer une clé de la
  liste lui retire la confiance aussitôt. Ce que git n'a pas pu vérifier (`E`) est redemandé.
  Les clés SSH de la liste, au format `allowed_signers` de git, sont écrites à côté
  (`.workpilot-brain/allowed_signers`, ignoré aussi).

Vérifié avec de vrais dépôts temporaires et de vraies signatures SSH (clés jetables faites par
`ssh-keygen` dans le dossier du test, `tests/brain/test_memory_signatures.py`) ; les runners Linux
et macOS de la CI posent `WORKPILOT_EXPECT_SSH_SIGNING`, sous lequel un `ssh-keygen` absent est un
échec et non un test sauté. GPG est vérifié par empreinte (pas de trousseau de test).

## Surfaces

- `GET /api/brain/memory/lifecycle` (avec les entrées reprenables et les chiffres),
  `GET …/history`, `POST …/forget`, `…/restore`, `…/pin`, `…/revert`, `…/scope`, `…/maintainers`,
  `…/conflicts/resolve`, `…/conflicts/suggest`, `…/signers` (`brain/lifecycle/api.py`, inclus
  dans le routeur du cerveau : refusé en mode serveur comme lui, le projet est un nom lu dans
  `project_dir`).
- Serveur : `/api/features/context/memory/{lifecycle,history,forget,restore,pin,scope,revert}`
  (`shared_features/context_lifecycle.py`, ci-dessus).
- Desktop : canaux `CONTEXT_MEMORY_*` (`main/ipc-handlers/context/memory-lifecycle-handlers.ts`,
  chaque argument revalidé), onglet **Cycle de vie** de la vue Contexte
  (`components/context/lifecycle/`), et Épingler / Oublier / Historique sur chaque mémoire de
  l'onglet Mémoires, pour un projet local comme pour un projet du serveur.

## Les mêmes paires, formulées autrement (`embeddings.py`), si un modèle est déjà là

Le détecteur demande des mots en commun : « toujours lancer les migrations avant les tests » contre
« ne jamais appliquer le schéma avant la suite de tests » n'en a aucun, et passait. Quand Ollama a
**déjà** un modèle d'embeddings, `review_pull` lui demande les vecteurs des notes reçues et des
notes vivantes du même dossier que la passe lexicale a laissées passer ; une paire dont la
similarité cosinus atteint `SIMILAR` (0,8) et dont un signal `negation` ou `recommendation` dit le
désaccord (`contradictions.compare_meaning`, sans exiger de mots communs) entre dans le même
arbitrage que les autres : mêmes règles sûres, même file, même escalade. Elle porte
`found_by: embeddings` (`lexical` pour les autres paires d'un pull), que l'onglet montre
(« Trouvé par le sens »), et sa similarité en détail (`≈ 0.91`). `value` reste lexical : deux
valeurs d'un réglage se trouvent par son nom, et un sens voisin n'est pas le même réglage.

- **Aucun téléchargement, aucune dépendance.** Ni sentence-transformers ni torch : le modèle est
  un de ceux qu'Ollama a déjà tirés (`/api/tags`), demandé sur `/api/embed`. Celui des réglages
  s'il y est (`x` vaut `x:latest`), sinon le premier modèle d'embeddings de la liste
  (`ollama_model_detector.is_embedding_model`), les multilingues d'abord (`bge-m3`,
  `multilingual-e5`, `nomic-embed-text`…) ; un modèle cloud n'est jamais pris. Un modèle nommé
  qu'Ollama n'a pas coupe la passe : il n'est jamais tiré.
- **La machine, jamais le réseau.** L'adresse est `offline_policy.local_endpoint("ollama")`, qui
  refuse tout ce qui n'est pas une boucle locale ; ni proxy ni redirection, un délai sur chaque
  appel (2 s pour la liste, 10 s par lot). Un modèle local est ce vers quoi la politique hors
  ligne stricte route : la passe tourne donc aussi sous elle.
- **Rien ne casse.** Pas d'Ollama, pas de modèle d'embeddings, un serveur arrêté, lent ou qui
  répond mal : la passe s'arrête là, sans erreur, et la détection est lexicale comme avant.
  Une réponse est lue comme des nombres (taille, dimension et finitude vérifiées), rien d'autre.
- **Borné.** Au plus `MAX_EMBEDDED` (200) notes envoyées par revue, la note reçue d'abord ; un
  vecteur est gardé par modèle et empreinte de la déclaration dans
  `.workpilot-brain/embeddings.json` (cette machine, ignoré par git, 2 000 vecteurs au plus, les
  plus récents), donc le pull suivant n'envoie que ce qui a changé. Le fichier est ouvert par
  `notes.inside` : un lien qui sortirait du cerveau n'est pas suivi.
- **Une note est une donnée.** Ce qui part est sa déclaration, expurgée (`memories.redact`) et
  coupée à 2 000 caractères ; deux notes de portées disjointes (`scopes.py`) ne sont même pas
  envoyées.
- **Réglages** : `BRAIN_CONFLICT_EMBEDDINGS` (`off` coupe) et `BRAIN_CONFLICT_EMBEDDINGS_MODEL`,
  sinon `brain.json` (`conflictEmbeddings`, `conflictEmbeddingsModel`), que Réglages → Cerveau
  écrit ; une variable posée rend son contrôle en lecture seule.
- **Le prix.** Le détecteur lexical rend le même verdict sur chaque machine ; cette passe dépend
  du modèle de la machine. Elle ne fait qu'*ajouter* des paires à trancher, jamais en retirer, et
  une paire réglée ailleurs arrive par le vault comme toute décision.

C'est pourquoi le contrat d'imports de `brain` s'élargit à `offline_policy` et
`ollama_model_detector`, deux feuilles que `docintel` lisait déjà : le plus grand cycle ne change
pas, et `brain` n'importe toujours ni `core` ni `services`.

## Ce qui reste (lots suivants)

Rien pour #348. Pour #352, ce qui attend une décision du mainteneur du projet :

- Embeddings sans Ollama (LM Studio, llama.cpp) et sur un projet du serveur : la passe ne lit
  que l'Ollama local, et un projet du serveur n'a pas de file de conflits.
- Signatures : une liste par projet couvre le dossier de ce projet ; les notes du reste du vault
  (connaissances hors projet, instructions partagées) n'en ont pas encore.
- Les projets du serveur n'ont pas de file de conflits (leur cerveau n'est jamais
  synchronisé), donc pas d'annonce ni de mainteneurs par portée.
- Les patterns du learning loop (leur injecteur et la source `PatternSource` de `mem_search`)
  ne sont pas encore filtrés par portée : une personne peut porter un tel pattern, mais il est
  servi à chaque build. Le filtre se pose sur `PatternStorage` sans toucher son écriture, qui
  relit tous les patterns pour retirer ceux qui ont disparu.
