# Changelog

All notable changes to WorkPilot AI are documented here. This is the only
changelog: `scripts/bump-version.js` and the release workflow read it. The
complete 1.0.0 notes and the upstream 2.x history lived in a second file,
`docs/CHANGELOG.md`, removed in audit lot L9; it remains in the git history
([last version](https://github.com/krovomi/WorkPilot-AI/blob/f385fe1/docs/CHANGELOG.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

Changes not released yet are not written here: each PR adds a fragment to
[`changelog.d/`](changelog.d/), and `python scripts/changelog.py release X.Y.Z "Title"`
folds them into a new section at release time (`python scripts/changelog.py preview`
shows the next notes). Two open PRs no longer edit the same lines.

## 1.6.1 - Planifier et proposer un sprint avec l'IA, des dates dans la langue de l'app

La vue « Planifier » d'un sprint montre sa capacité face à la vélocité et se manie au glisser-déposer
ou au clavier, et « Proposer le sprint » remplit le sprint jusqu'à sa capacité avec l'IA du provider
choisi, une raison par tâche (des règles proposent seules sans modèle). Les dates et les heures suivent
la langue de l'app sur le bureau et le mobile, la microVM d'une tâche reste fermée à son allowlist, et
les builds de release tournent sur un Node.js accepté par REA.

### ✨ Nouveautés

- **La vue « Planifier » d'un sprint montre sa capacité et se manie plus vite** : une jauge en points compare le sprint à la vélocité des 3 derniers sprints (ou à une cible pour un premier sprint), avec l'historique à côté ; la disponibilité de l'équipe se règle en %. Les tâches se glissent d'un côté à l'autre, ou s'envoient au clavier, et le dernier déplacement s'annule. Le backlog a des filtres rapides (urgentes, bugs, non estimées) et un bouton « Estimer » ; une tâche reportée du sprint précédent est marquée, une tâche qui attend une tâche restée au backlog aussi, avec « L'ajouter aussi ». Un sprint planifié démarre depuis la vue.
- **Le sprint en cours s'affiche au-dessus du Kanban, et se planifie** : un bandeau nomme le sprint actif (ou celui du filtre) avec ses dates, les jours restants et son avancement. Il permet de n'afficher que ses tâches, de le planifier, de le démarrer ou de le terminer. La vue « Planifier » met le backlog à côté des tâches du sprint : on coche des tâches pour les ajouter ou les renvoyer, et la vélocité signale un sprint trop chargé. Elle s'ouvre aussi dès qu'un sprint est créé.
- **Moteur de « Proposer le sprint »** : à partir de la capacité du sprint (sa vélocité), des règles classent le backlog (priorité, bugs, ce qu'une tâche débloque, but du sprint, âge) et ajoutent d'abord ce qu'une tâche attend ; le modèle du provider choisi compose le sprint parmi les mieux classées et explique chaque choix dans la langue de l'app, puis les règles vérifient que la capacité tient. Sans modèle, les règles proposent seules. Le modèle ne lit que le titre, le début de la description, la priorité, le type, les points, les étiquettes et les dépendances.
- **« Proposer le sprint » dans la vue Planifier** : depuis le bandeau du sprint, la vue Planifier ou la création d'un sprint, on règle l'objectif, la capacité et l'intention (Équilibré, Plus prudent, Bugs d'abord, Autour du but), puis l'IA du provider choisi propose les tâches qui remplissent le sprint, en pointillés violets, chacune avec sa raison. Sous la ligne de capacité, les meilleures qui n'y tiennent pas ; on retire, on ajoute, on relance une variante, on prend l'objectif proposé, puis « Ajouter N tâches », annulable. Sans modèle, des règles proposent quand même.

### 🐛 Corrections

- **Les champs de date suivent la langue de l'app** : les dates de sprint, de rapport d'usage, de délégation, de changelog, le mois de conformité et les heures d'automatisation s'écrivent 28/11/2026 et 14:30 en français, avec un calendrier qui commence le lundi ; l'anglais garde 11/28/2026 et 02:30 PM. Avant, ces champs natifs prenaient le format de la région du système (mm/dd/yyyy sous un Windows anglais).
- **Plus aucune date brute** : les mois (2026-11) et les jours (2026-11-28) encore affichés tels quels sur le bureau (conformité, carbone, Best-of-N, notebooks, déploiements, revues de PR, branches, usage, tests instables) et sur le mobile (mon usage, vue d'ensemble de l'administration) passent au format de la langue.
- **MicroVM Docker.** La VM d'une tâche n'atteint que les hôtes de la liste de la tâche, une
  commande arrêtée au délai s'arrête aussi dans la VM, sbx est lancé sans les identifiants de
  l'hôte, et OpenCode s'installe dans la VM sans Node.

### 🧪 Filets de test

- **Le test des chemins refusés en mode serveur ouvre sa propre base** : il reprenait le moteur de base laissé par un test précédent, lié à une autre boucle d'événements, et échouait selon l'ordre des tests (CI de main après la 1.6.0).

### 📚 Documentation

- **Planifier et proposer un sprint, dans les README, la liste des fonctionnalités et le wiki** : la jauge de capacité, les déplacements rapides et « Proposer le sprint » (variantes, but suggéré, ce que lit le modèle).

### 🧹 Maintenance

- **Les builds de release demandent un Node.js accepté par REA** : l'audit de l'app empaquetée refusait le Node 22 trop ancien du runner macOS ; `release.yml` demande désormais `^22.23.4`, la plage de `apps/backend/rea/pin.json`, et un test garde les deux d'accord.

---

## 1.6.0 - Un Kanban agile qu'on interroge, plusieurs comptes par IA et par forge

Le Kanban devient un tableau agile comme Jira (colonnes Échec et Abandonnée, sprints, couloirs, liste,
frise, rapports, étiquettes) qu'on interroge dans n'importe quelle langue, avec des cartes colorées par
type, l'ajout rapide, le clic droit et la sélection multiple. Chaque provider IA et chaque forge prend
plusieurs comptes (un par défaut, un budget mensuel, un compte épinglé par projet ou par carte, la bascule
d'abord vers les autres comptes du même provider), et OpenRouter, Hugging Face et Bitbucket Cloud
rejoignent la liste. L'app décide où tournent les longues suites de tests, les PR reçoivent un niveau
d'approbation N0 à N3, le mode code et une microVM par tâche arrivent, et le serveur d'équipe mesure
l'usage dans le cadre du RGPD, avec un rapport quotidien et des budgets de jetons.

### ✨ Nouveautés

- **Les conflits de mémoire formulés autrement sont trouvés par un modèle local** (#352). Quand
  Ollama a déjà un modèle d'embeddings (`nomic-embed-text`, `bge-m3`…), une synchronisation du
  cerveau lui demande aussi quelles notes parlent de la même chose : « toujours lancer les
  migrations avant les tests » contre « ne jamais appliquer le schéma avant la suite de tests » est
  signalé sans mot en commun, et la paire est marquée « trouvée par le sens ». Rien n'est
  téléchargé, rien ne quitte la machine (adresse locale seulement) ; sans modèle, la détection reste
  celle des mots. Interrupteur et modèle dans Réglages → Cerveau (`BRAIN_CONFLICT_EMBEDDINGS`,
  `BRAIN_CONFLICT_EMBEDDINGS_MODEL`).
- **Les patterns du learning loop respectent la portée d'une mémoire** (#352). Un pattern porté
  `branch:dev` ou `team:paiements` n'entre plus dans le prompt d'un build d'une autre branche (ni,
  en mode serveur, d'un run lancé hors de l'équipe), et `mem_search` ne le sert plus ; le magasin
  des patterns, lui, les relit tous avant d'écrire, si bien qu'aucun pattern porté ailleurs n'est
  oublié par un build qui ne le voit pas.
- **LM Studio, en plus d'Ollama, pour trouver les conflits de mémoire formulés autrement** (#352).
  Quand Ollama n'a pas de modèle d'embeddings, un modèle que LM Studio liste déjà sur son serveur
  local (`/v1/models`, `/v1/embeddings`) est interrogé ; rien n'est téléchargé, rien ne quitte la
  machine. Réglages → Cerveau permet de choisir le serveur (`BRAIN_CONFLICT_EMBEDDINGS_PROVIDER`)
  et dit lequel a été trouvé, avec son modèle.
- **Les notes partagées hors projets peuvent exiger une signature de confiance** (#352). Le
  cerveau a désormais sa propre liste de signataires (Réglages → Cerveau), à côté de celle de
  chaque projet : une connaissance, une instruction partagée ou un skill du cerveau reçu d'un
  coéquipier ne va plus aux agents (rappel, lecture, prompts, `INSTRUCTIONS.md`, skills) si son
  dernier commit n'est signé par aucune clé de la liste. Sans liste, rien ne change ; une
  modification de la liste poussée par quelqu'un d'autre ne compte que signée par une clé déjà
  listée.
- **Avis sur les serveurs MCP partagés par l'organisation** (#369) : en mode serveur, l'avis
  qu'un membre laisse sur un serveur du catalogue du Marketplace MCP vaut désormais pour tous les
  projets de son organisation, et seulement pour elle : aucune autre organisation ne le voit.
  Écrire un avis est réservé aux mainteneurs et aux administrateurs (`marketplace.write`) ; les
  membres les lisent. L'auteur ou un administrateur de l'organisation supprime un avis. Les avis
  déjà écrits sont rattachés à l'organisation de leur projet (le plus récent est gardé quand une
  personne avait laissé un avis sur le même serveur dans deux projets).
- **Serveur confiné sans bac à sable : refusé, et l'app dit pourquoi** (#369) : un serveur MCP qui
  doit tourner confiné ne démarre jamais sans le bac à sable de l'OS. La liste des serveurs
  installés, Agent Tools et le bandeau de la politique le disent désormais sous chaque serveur
  concerné, avec « Pourquoi ? » : bac à sable désactivé, système sans bac à sable (Windows),
  `bubblewrap` absent ou refusé par le noyau, `sandbox-exec` absent ou refusé ; « Vérifier à
  nouveau » relance la vérification après une installation.
- **Enregistreur du Browser Agent, lot 6** (#387) : les tests Selenium Java et C# lisent eux aussi leurs valeurs saisies dans un fichier JSON, comme les autres langages. Java le lit dans les ressources de test de son paquet (`src/test/resources/e2e/<test>.data.json`) avec le lecteur JSON de Selenium, C# à côté de sa source avec `System.Text.Json` : aucune dépendance ajoutée. Pour chaque format, un secret est rangé dans ce fichier par le nom de sa variable d'environnement (`"password_env": "E2E_PASSWORD"`), jamais par sa valeur, et le test lit la variable au moment de tourner. L'onglet montre le fichier même quand il ne contient que des secrets.
- **Coupe-circuit et arrêt d'urgence des agents** (#353) : un agent qui appelle le même outil avec les mêmes arguments et obtient le même résultat cinq fois, sans modifier de fichier entre-temps, est mis en pause, quel que soit le fournisseur (SDK Claude, CLI Codex, Copilot, OpenCode, pi, agents ACP, modèles OpenAI, Google, compatibles et locaux) ; une notification le dit et la carte nomme l'outil. « Arrêter tous les agents » (bouton rouge de la barre latérale tant qu'une tâche tourne, raccourci Ctrl+Maj+.) met en pause chaque tâche en cours, à reprendre depuis sa carte, et arrête les autres agents.
- **Instantanés et retour arrière** : avant chaque session d'agent (planification, codage, QA),
  le worktree de la tâche est enregistré comme un commit git caché, pour toutes les stacks
  (`.gitignore` décide de ce qui est copié). La carte d'une tâche en pause liste ses instantanés
  et en restaure un après confirmation ; l'état remplacé est gardé comme instantané lui aussi.
- **Score de confiance** : chaque session démarre à 100 et chaque anomalie (chemin hors projet,
  suppression de masse, commande dangereuse, secret lu, accès réseau, configuration de sécurité
  modifiée…) le fait baisser, sur tous les providers. Sous le seuil de pause, la tâche se met en
  pause ; sous le seuil d'arrêt, la session est arrêtée et son instantané restauré. La carte
  affiche le score et ce qui l'a fait baisser.
- **Sandbox** : mode restreint (seuls les chemins listés sont inscriptibles), nombre de fichiers
  écrits, taille d'un fichier et durée de session par session. Paramètres, Sandbox et Détection
  d'anomalies enregistrent enfin leurs réglages, que le backend applique.
- **Un compte IA par projet et par carte.** Dans Paramètres du projet → Agent, chaque provider qui a
  plusieurs comptes (clés API de Réglages → Comptes IA, ou profils Claude) peut être épinglé sur
  l'un d'eux pour toutes les tâches du projet. Une carte Kanban choisit aussi le sien, à l'étape
  Moteur de sa création ou de sa modification, pour les providers de ses phases ; sans choix, elle
  suit le projet, puis le compte par défaut. Un compte supprimé rend la tâche au compte par défaut.
  Une tâche épinglée sur un profil Claude que la bascule automatique remplace repart sur le profil
  de secours, et la limite atteinte est comptée au profil épinglé.
- **Dépense et budget par compte IA** : chaque session d'agent note le compte IA sur lequel elle
  a tourné (compte par défaut d'un provider à clé API, ou profil Claude), sans jamais une clé.
  Réglages → Comptes IA affiche, pour chaque compte, ce qu'il a dépensé ce mois-ci et ses tokens,
  additionnés sur tous les projets de l'ordinateur ; la popin d'utilisation montre la dépense à
  côté de chaque compte. Un budget mensuel optionnel par compte envoie une alerte à 80 % puis à
  100 %, une fois par mois, sur le bureau et sur ntfy ou Telegram quand ils sont réglés. Tout reste
  sur l'ordinateur : rien n'est envoyé, un budget et ses alertes disparaissent avec le compte.
- **Dépense des comptes des outils CLI** : une session lancée sur le compte connecté par défaut de
  Copilot, Codex CLI ou Gemini CLI est notée sur ce compte, et Réglages → Comptes IA affiche sous
  chacun de ces comptes ce qu'il a dépensé ce mois-ci, avec son budget mensuel optionnel.
- **Basculement entre plusieurs comptes d'un même provider** : chaque compte de Réglages → Comptes
  IA (OpenAI, Google, Mistral, DeepSeek, Grok, Meta, OpenRouter, Hugging Face) est une entrée de la
  chaîne de basculement. Une tâche arrêtée par une limite (429), un quota ou un crédit épuisé (402)
  ou une clé refusée (401) reprend sur le compte suivant du même provider, dans l'ordre de la
  chaîne, avant d'essayer un autre provider (interrupteur « D'abord les autres comptes du même
  provider »). Seule la tâche arrêtée change de compte : le compte par défaut des autres reste le
  même, et le compte quitté est mis de côté une heure (six après une clé refusée).
- **Basculement vers les comptes Copilot, Codex CLI et Gemini CLI** : les comptes connectés de ces
  outils sont des entrées de la chaîne de basculement. Une tâche Copilot arrêtée par une limite
  reprend sur le compte GitHub suivant, une tâche OpenAI peut passer d'une clé à une connexion
  Codex CLI (ou l'inverse), et le compte choisi est épinglé sur la tâche seule. Un compte qui n'est
  pas connecté est sauté.
- **Réglages → Comptes IA** : la page est refaite selon la charte. Un résumé dit combien de
  providers sont connectés, lequel est par défaut, si le basculement est actif et ce qui demande
  attention ; chaque provider est une carte qui dit comment il se connecte, s'il répond, son usage
  et l'âge de sa clé, avec une recherche et des filtres (connectés, à connecter, à vérifier).
- **Basculement auto pour tous les providers** : une tâche arrêtée par une limite ou une connexion
  perdue reprend sur le compte suivant d'une chaîne que l'on ordonne (comptes Claude, profils API,
  Copilot, OpenAI, Mistral, Ollama…), à la phase où elle s'est arrêtée. Les interrupteurs de la page
  sont désormais ceux que l'application applique : les anciens n'étaient jamais lus, il faut donc
  vérifier une fois que le basculement est bien activé.
- **Plusieurs comptes pour Copilot, Codex CLI et Gemini CLI.** Dans Réglages → Comptes IA, la
  carte Copilot, la carte Gemini CLI et la carte OpenAI (pour Codex CLI, l'offre ChatGPT) gardent
  maintenant plusieurs connexions : chaque compte se connecte dans un dossier à lui, depuis le
  terminal intégré (`gh auth login`, `codex login`, `gemini`), et l'un d'eux devient le compte par
  défaut des tâches. Sans compte par défaut, l'outil garde la connexion de l'ordinateur. La bascule
  se fait aussi depuis la popin d'utilisation en haut à droite, et l'usage de Codex suit le compte
  choisi. Aucun jeton n'est copié par WorkPilot : chaque outil garde sa propre connexion, et
  supprimer un compte efface son dossier.
- **Plusieurs comptes pour AWS Bedrock, Cursor et Windsurf.** Dans Réglages → Comptes IA, ces
  trois cartes gardent maintenant plusieurs comptes, comme OpenAI ou Mistral. Un compte AWS se
  compose de son identifiant de clé, de sa clé secrète et de sa région (`us-east-1` si rien n'est
  saisi) : le compte par défaut donne les trois à chaque tâche, alors qu'avant seule la première
  partie était transmise. Les clés restent chiffrées et ne sont jamais réaffichées. WorkPilot ne
  peut pas vérifier ces clés à l'enregistrement : la première tâche le dit.
- **Les connexions Copilot, Codex CLI et Gemini CLI s'épinglent aussi.** Un projet (Paramètres du
  projet → Agent) ou une carte Kanban (étape Moteur) peut faire tourner Copilot ou Gemini CLI sur
  l'une de leurs connexions de Réglages → Comptes IA, et OpenAI sur une connexion Codex CLI (offre
  ChatGPT) au lieu d'une clé. Sans choix, la tâche suit le projet, puis le compte par défaut, puis
  la connexion de cet ordinateur ; un compte supprimé ou déconnecté rend la tâche au défaut.
- **Plusieurs comptes par provider IA.** Réglages → Comptes IA : le bouton « Comptes » de chaque
  carte liste les comptes du provider, en ajoute (clé API testée aussitôt pour OpenAI, Google,
  Mistral, DeepSeek, Grok, Meta, OpenRouter et Hugging Face ; connexion dans le terminal intégré
  pour Claude) et choisit celui par défaut. Le compte par défaut est celui des nouvelles tâches,
  des tests de connexion et des vues. La popin d'utilisation, en haut à droite, bascule d'un compte
  à l'autre en un clic. Les clés restent chiffrées dans le processus principal et ne sont plus
  jamais affichées.
- **Émulateur d'application : la matrice d'appareils, vivante et à vous** (#383). Un mode « Vues vivantes » montre les appareils cochés côte à côte sur la page vivante (six au plus) : naviguer ou défiler dans l'une fait de même dans les autres, et le rechargement à chaud du serveur de dev les met toutes à jour. Vous pouvez ajouter vos propres appareils (fenêtre, densité, user agent), enregistrer la session de l'aperçu comme persona (« admin », « client ») pour capturer une page connectée sous l'identité voulue, ses cookies chiffrés par le trousseau du système et jamais affichés, et lire une page à chacun de ses points de rupture pour voir à quelle largeur la mise en page casse.
- **Émulateur d'application : matrice d'appareils en paysage, avec la session de l'aperçu, d'office à la revue, et exportée en PDF** (#383). Les téléphones et tablettes se capturent aussi en paysage. Sur demande, chaque capture reprend les cookies que l'aperçu envoie au serveur : une page derrière une connexion s'affiche comme on la voit. Les éléments fautifs sont encadrés sur chaque capture et dans l'export, et la lecture signale une navigation mobile inaccessible (liens cachés sans bouton de menu, bouton de menu qui ne commande rien). À la revue d'une carte dont les changements touchent l'interface, la matrice s'ouvre d'elle-même sur quatre appareils quand le serveur de la tâche tourne. La grille s'exporte en PNG ou en PDF.
- **Émulateur d'application : bridage, nouveaux bugs détectés et export de la matrice d'appareils** (#383). Chaque capture peut se faire sur un réseau bridé (4G, 3G rapide, 3G lente) et un processeur ralenti (×2, ×4, ×6), choisis dans une liste ; la grille montre le temps de chargement de chaque appareil. La lecture de la page signale aussi les éléments qui se chevauchent et le texte coupé ou qui déborde de sa boîte. **Exporter** enregistre la grille entière, chaque capture sous le nom de son appareil, en une seule image PNG, à l'endroit choisi dans la boîte d'enregistrement.
- **Émulateur d'application : matrice d'appareils** (#383). La page de l'aperçu se rend sur plusieurs appareils prédéfinis à la fois (iPhone, Pixel, Galaxy Fold, iPad, ordinateur Full HD et 4K, téléviseur), avec leur taille d'écran, leur densité, leur user agent et le tactile, et s'affiche en grille côte à côte. Chaque rendu signale les bugs responsive classiques : page qui défile de côté, image trop large, cible tactile de moins de 44 px, texte de moins de 12 px. Une capture peut être gardée pour la revue visuelle.
- **Leçons appliquées à une tâche** (#345) : la vue d'ensemble de la tâche dit « N leçons appliquées à cette tâche » et liste ce que chaque prompt a reçu de la boucle d'apprentissage (règles adoptées en revue, motifs appris des builds, points de contrôle du type de tâche), avec l'agent qui l'a reçu. Une leçon se désactive pour cette tâche seule : les prompts suivants la laissent de côté, les autres tâches la gardent. La spec d'un correctif, d'un refactoring, d'une montée de version… reçoit les points de contrôle de son type (reproduire le bug dans un test d'abord, nommer le comportement à préserver…) quand l'historique QA du dépôt le demande : au moins trois tâches de ce type, 1,5 passe QA en moyenne ou deux sur cinq rejetées à la première. Ce choix vaut pour tous les fournisseurs et toutes les piles.
- **Niveau de validation sur les cartes, et fusion seule quand il le permet.** Quand la PR d'une
  tâche est verte, la carte montre son niveau (N0 à N3) et ce qui en découle. Une nouvelle page
  Paramètres → Sécurité → Validation par niveaux règle le mode : Arrêtée, Observer (par défaut,
  rien ne fusionne seul) ou Appliquer, où une PR N0, ou N1 approuvée par la revue croisée sur le
  même code, fusionne seule. Pour tous les providers ; PR GitHub pour l'instant.
- **Le bac à sable d'une tâche compte dans le niveau de validation de sa PR.** WorkPilot garde
  le bac à sable de chaque session (microVM Docker, bac à sable de l'OS ou aucun) et les hôtes
  qu'il a refusés. Une tâche lancée sans bac à sable, ou qui a tenté d'atteindre un hôte refusé,
  passe au niveau N2 et attend une personne. Une règle de `workpilot.policy.yaml` peut exiger la
  microVM (`task/sandbox`).
- **Validation par niveaux des pull requests, en mode observation.** Chaque PR reçoit un niveau
  lu sans modèle : N0 (montée de version, documentation), N1 (correctif d'une seule couche, après
  la revue croisée), N2 (feature, plusieurs couches, migration, contrat d'API, montée majeure) ou
  N3 (secrets, auth, données personnelles, paiement, CI, fichiers de politique). N0 et N1 pourront
  fusionner seules quand la CI est verte ; N2 et N3 attendent une personne. Toutes les piles, tous
  les fournisseurs, toutes les forges. Ce premier lot livre le moteur et la section `approvals` de
  `workpilot.policy.yaml` (qui ne peut que durcir) ; rien ne fusionne encore seul.
- **Dérive d'architecture pour toutes les stacks** : les imports sont lus en C#, F#, VB (et
  références de projets `.csproj`), Java, Kotlin, Scala, Go, PHP, Rust, Dart/Flutter et Swift,
  en plus de Python et TypeScript. Sans fichier de règles, les couches Domaine, Application,
  Infrastructure et Présentation sont déduites des projets .NET (`Shop.Domain`, `Shop.Api`…),
  des modules Maven/Gradle, des paquets Kotlin, de `go.mod`, de `composer.json`, de
  `Cargo.toml`, de `pubspec.yaml` et des cibles Swift ; la règle de dépendance et
  l'interdiction des frameworks de persistance ou web dans le domaine sont vérifiées, et
  chaque violation est formulée dans la langue de l'app.
- **Le pilote de pile pose le niveau de validation de chaque PR de WorkPilot.** Avant de fusionner
  une PR verte vers `develop`, il ajoute le label `niveau:N0` à `niveau:N3`. Par défaut il ne fait
  qu'observer et fusionne comme avant ; avec la variable de dépôt `APPROVAL_TIERS=enforce`, les PR
  N2 et N3 attendent qu'une personne pose le label `approuvé`.
- **Bitbucket Cloud** : un projet local peut se connecter à son dépôt bitbucket.org
  (Réglages du projet > Bitbucket : jeton chiffré, dépôt rempli depuis le remote, test de
  connexion). Ses issues (filtre, recherche, commentaires, import en tâches), ses pull requests
  (fichiers, diff, commentaires) et ses pipelines ont leur vue ; Bitbucket Pipelines suit la CI
  d'une tâche, et « Créer la PR » d'une tâche ouvre sa pull request sur Bitbucket.
  Un projet peut aussi choisir un compte Bitbucket enregistré une fois dans Réglages > Comptes
  des forges, comme pour GitHub, GitLab et Azure DevOps.
- **Enregistreur du Browser Agent, lot 3** (#387) : après une action, l'enregistreur propose de vérifier ce qui vient d'apparaître (un statut, une alerte, un titre), et une vérification gardée se place juste après son action. Un sélecteur qui désigne plusieurs éléments (trois boutons « Ajouter ») garde la place de l'élément au lieu de faire échouer le test, et le test attend qu'un indicateur de chargement apparu après l'action ait disparu.
- **Enregistreur du Browser Agent, lot 5** (#387) : les valeurs saisies pendant l'enregistrement (e-mails, dates, nombres, noms…) ne sont plus écrites dans les étapes du test. Le test les lit par une clé, dans un fichier de données écrit à côté de lui (JSON pour Playwright, WebdriverIO et Selenium en Python, JavaScript et Ruby ; une fixture `cy.fixture` pour Cypress) ou dans un bloc de constantes `TestData` en Java et en C#. L'onglet montre chaque clé avec ce qu'elle contient et le fichier, que la carte de revue écrit avec le test. Les secrets restent des variables d'environnement.
- **Enregistreur du Browser Agent, lot 4** (#387) : les survols, défilements, glisser-déposer, textes modifiables et listes à choix multiples sont enregistrés, et une boîte de dialogue ouverte par la page se répond depuis l'app, puis se rejoue dans le test. Nouveaux exports Selenium en C#, Ruby et JavaScript, et WebdriverIO en TypeScript. Le test proposé sur une carte de revue se lance dans le worktree de la carte, sans identifiants, et l'app compte combien de tests enregistrés passent au premier essai ; un enregistrement se rejoue sans fenêtre pour voir quels sélecteurs ont changé et prendre les nouveaux. Le modèle rapide du provider (ou des règles, sans provider) propose un nom pour le test et classe les vérifications, sans recevoir ce que vous avez saisi.
- **Enregistreur du Browser Agent, lot 2** (#387) : une session s'exporte aussi en test Selenium (Python, Java) ou WebdriverIO, et l'enregistreur suit les iframes et les shadow roots ouverts, que chaque export traverse. Le test attend ce que chaque action a provoqué (la page où elle mène, la requête qu'elle lance, l'élément qui apparaît) au lieu de marquer des pauses, et chaque valeur enregistrée est écrite comme un littéral de la langue cible, guillemets, antislashs, retours à la ligne et `${}` compris.
- **Enregistreur du Browser Agent** (#387, lot 1) : l'onglet « Enregistreur » ouvre une page dans une fenêtre de navigateur, enregistre les clics, saisies, choix, touches Entrée et Échap, navigations et vérifications de texte (Alt+clic), puis exporte les étapes gardées en test Playwright (TypeScript ou Python) ou Cypress. Les sélecteurs suivent l'ordre recommandé (test id, rôle et nom accessible, label, texte, CSS court en dernier recours) ; un mot de passe ou un secret n'est jamais enregistré et le test le lit dans une variable d'environnement. Le test s'affiche, se propose sur une carte de revue (sa propre branche) ou s'enregistre dans un fichier hors du projet, jamais directement dans le dossier du projet. Aucun modèle n'est appelé.
- **Build Analytics, « Où vous en êtes », fin** (#359) : deux chiffres de plus, le score de
  mutation de la QA et le taux de CI verte du premier coup (le suivi de la PR note désormais ce
  que la CI disait de la PR telle qu'elle a été ouverte), où plus haut est mieux. Chaque groupe
  donne sa tendance, et « Votre rythme face à vos pairs » dit si le projet progresse plus vite
  ou moins vite que la médiane de son groupe. Un projet qui change de taille ou d'équipe est
  comparé aux deux segments pendant 30 jours, sans saut. Toujours sans service central.
- **Build Analytics, « Où vous en êtes », suite** (#359) : les specs se comparent aussi type de
  travail par type (correctif, feature, refactorisation…) et à des projets de même taille
  d'équipe ; chaque groupe donne le chiffre des 10 % les meilleurs (à partir de 10 de vos projets,
  ou de 20 projets de l'organisation en mode serveur), et une courbe montre les 8 dernières
  semaines du projet. « Générer le rapport d'équipe » enregistre la comparaison en PDF. Toujours
  sans service central : tout est lu dans les dossiers des projets.
- **Build Analytics, « Où vous en êtes »** (#359) : un onglet compare le projet à ses 30 jours
  précédents et à vos autres projets de même pile et de même taille, en minutes, coût, itérations
  de QA et agents par spec, sur tous les providers. En mode serveur, la comparaison porte sur les
  projets de l'organisation que vous pouvez lire, en médianes seulement, à partir de 5 projets.
  Tout est lu dans les dossiers des projets : rien ne quitte l'ordinateur ni le serveur.
- **Claude Ship, détecté tout seul.** Quand un compte Claude connecté est sur un plan Team ou
  Enterprise, WorkPilot lit les checks de Claude Code Review et de Claude Approvals sur la PR d'une
  tâche : Code Review remplace une revue croisée absente, Approvals ne peut que retenir une fusion,
  et WorkPilot arrête ses propres correctifs sur une PR que PR Steward suit. Paramètres → Sécurité →
  Validation par niveaux : Automatique (par défaut), Activé ou Désactivé.
- **Mettre à jour toutes les CLI d'un clic** : quand au moins une CLI a une nouvelle version
  (Claude Code, Codex, Copilot, Gemini, OpenCode, pi, Hermes), le panneau « Outils CLI » affiche
  en bas « Tout mettre à jour (N) ». Les mises à jour passent l'une après l'autre avec leur
  progression (« Mise à jour 2/3… »), chaque ligne garde son indicateur et son message d'erreur,
  et le bouton disparaît quand tout est à jour.
- **Mode code de Claude Code dans les tâches Claude et les terminaux.** Avec Paramètres, Mode code
  sur Auto ou Activé, une phase Claude du Kanban qui tourne dans le worktree de sa tâche, sur l'API
  Anthropic avec Opus ou Sonnet 5.5 et suivants, prend le mode code de Claude Code ; chaque script
  est gardé dans la spec de la tâche, et chaque appel qu'il fait passe les mêmes hooks qu'un appel
  direct. Les terminaux le reçoivent aussi. Le moteur d'une tâche, sous « Avancé : un moteur par
  phase », choisit le mode code de chaque phase (Comme les Paramètres, Arrêté, Auto, Activé).
- **Mode code pour tous les fournisseurs de la boucle WorkPilot.** Un agent peut écrire un court
  script JavaScript (`run_script`) qui enchaîne ses outils en une étape : la même modification sur
  plusieurs fichiers, une recherche filtrée avant lecture, lint et tests lancés en parallèle. Il
  marche avec OpenAI, Google, Mistral, Copilot, Windsurf, Ollama, LM Studio, les fournisseurs
  compatibles et les passerelles. Arrêté par défaut : Paramètres, Mode code (Arrêté, Auto, Activé) ;
  une tâche peut le choisir pour elle ou par phase. Chaque appel du script passe les mêmes contrôles
  qu'un appel direct, et la surveillance des anomalies les compte tous. Le banc de rejeu mesure ce
  qu'il change (cartes résolues, coût, durée) en rejouant chaque moteur sans lui et avec lui.
- **Budgets de coût appliqués pendant l'exécution** (#355) : la page Coûts règle un budget du projet (par mois, semaine ou au total) et un plafond par tâche. Avant chaque session d'agent, quel que soit le fournisseur, la tâche note les seuils franchis dans son journal, se met en pause au plafond (une notification le dit, « Relever et reprendre » sur la carte) et peut passer à un modèle plus léger du même fournisseur quand le budget s'épuise. Une tâche qui dépense sans terminer de sous-tâche est aussi mise en pause.
- **Après un mauvais verdict de la surveillance de déploiement** : un rapport d'incident
  (référence, pire valeur et dernière valeur de chaque métrique, mesures critiques et dégradées,
  réponses du health check, rollback), suivi de quelques phrases du modèle du projet, quel que
  soit son fournisseur (`explain_incident: false` dans `.workpilot/deploy-monitors.yaml` le
  retire) ; une notification sur le bureau et les canaux configurés (ntfy, Telegram) ; et, si le
  fichier dit `revert_pr: true`, une PR qui revert le commit déployé, préparée dans un worktree et
  une branche à elle et ouverte sur la forge du projet (GitHub, GitLab, Azure DevOps). Rien n'est
  jamais poussé sur la branche par défaut.
- **Rollback coordonné des services liés** : sur la page CI/CD d'un projet, on choisit les
  autres projets de l'app qui reviennent en arrière avec lui (le frontend avec son backend).
  Quand son rollback démarre, chacun revient, avec ses propres réglages CI/CD, là où il était à
  la dernière bonne exécution du premier ; une migration ou un fournisseur sans rollback par API
  le laisse à une personne, et la page dit ce que chacun a fait. Le lien est gardé par l'app,
  jamais dans un dépôt.
- **Rollback par feature flag** : quand les réglages CI/CD nomment le flag qui garde la release
  (Unleash, LaunchDarkly ou ConfigCat), un verdict critique le coupe d'abord : rien n'est
  redéployé et une migration ne bloque pas. Si le flag ne peut pas être coupé, le déploiement
  revient en arrière comme avant. Le jeton est gardé chiffré.
- **Analyse canary** : une métrique de `.workpilot/deploy-monitors.yaml` peut porter une
  `canary_query` ; chaque mesure compare alors le canary au parc stable au même moment.
- **Grafana** rejoint Prometheus, Datadog, New Relic et CloudWatch comme source de métriques
  (URL, jeton de compte de service chiffré, uid de la source de données).
- **Chiffres de la surveillance**, calculés sur la machine : rollbacks automatiques et demandés
  par mois, délai entre la dégradation et le rollback (objectif : trois minutes), incidents
  évités, fausses alertes. Un mauvais verdict se juge sur la page (« fausse alerte » ou « vrai
  problème ») ; le rapport d'incident mène à Self-Healing et à la tâche dont la PR a été déployée.
- **Surveillance après déploiement et rollback** : un pipeline lancé depuis les déclencheurs
  CI/CD est suivi pendant une fenêtre d'observation (15 minutes par défaut). Le health check et
  les métriques Prometheus de `.workpilot/deploy-monitors.yaml` (taux d'erreur, latence, débit ou
  métrique métier) sont comparés à leur niveau d'avant le déploiement ; deux mesures critiques
  d'affilée donnent le verdict « critique ». Le rollback est alors proposé sur la page, ou lancé
  tout seul si le réglage le demande : GitHub Actions relance la dernière exécution réussie,
  Azure Pipelines redéploie son commit ; GitLab CI et Jenkins donnent le lien de la dernière bonne
  exécution. Une migration de base de données dans le changement (Alembic, Django, Rails,
  Laravel, Entity Framework, Flyway, Liquibase, Prisma, Ecto, Room…) bloque le rollback
  automatique et est nommée.
- **La surveillance de déploiement lit Datadog, New Relic et CloudWatch**, en plus de
  Prometheus : la source se choisit dans les réglages CI/CD, ses clés y restent chiffrées, et
  chaque métrique de `.workpilot/deploy-monitors.yaml` s'écrit dans le langage de la source.
  Un mauvais verdict part aussi sur **Slack**, par **e-mail** (SMTP) et, s'il est critique, sur
  **PagerDuty** pour la personne d'astreinte ; la page dit ce que chaque canal a reçu. Avec
  Jenkins, le commit déployé est lu dans le build : la migration bloque le rollback et la PR de
  revert s'ouvre, comme pour les autres fournisseurs.
- **Import Design : budget en jetons et en coût, passe responsive, survol et focus** (#379).
  La boucle de rendu s'arrête aussi quand son budget en jetons ou en dollars serait dépassé, et
  dit lequel ; le coût vient du catalogue des prix, sinon il est affiché « inconnu ». Le nombre
  d'itérations, le seuil et les deux budgets se choisissent dans la page. Sur demande, la version
  retenue est rendue en mobile, tablette et bureau (débordement, texte coupé, chevauchements), et
  les premiers éléments interactifs sont capturés au survol et au focus : un état qui ne change
  rien à l'écran est signalé.
- **Import Design : zones masquées à la main, correction d'après les passes, LM Studio et
  llama.cpp** (#379). Sur l'étape « Code », on trace sur la maquette les zones à
  exclure du score (date, photo, données en direct). Sur demande, ce que les passes responsive et
  survol/focus ont trouvé est renvoyé une fois au modèle ; la correction n'est gardée que si elle
  réduit les problèmes sans éloigner la page de la maquette. Avec l'abonnement Claude, la
  correction répond dans un schéma imposé, et la boucle tourne aussi avec un modèle de vision
  servi par LM Studio ou llama.cpp sur cette machine.
- **Import Design : réponse imposée sur tous les providers et chiffres de la boucle**
  (#379). Les corrections de la boucle de rendu répondent désormais dans un schéma imposé avec
  la clé d'API Claude, OpenAI, Gemini, Ollama, LM Studio et llama.cpp, comme avec l'abonnement
  Claude (une réponse en texte reste lue). Sous la maquette, la page donne les chiffres de la
  boucle sur le projet : score moyen retenu, corrections moyennes pour converger, et part des
  écritures arrivées dans le projet sans retouche (approximation, gardée sur cet ordinateur).
- **Import Design compare son code à la maquette et le corrige** (#379). Après la génération,
  le code est rendu dans un navigateur sans réseau ni JavaScript, comparé à l'image zone par
  zone, puis corrigé par le modèle de vision du provider choisi, jusqu'à cinq fois ou jusqu'au
  seuil de ressemblance. La meilleure version est gardée ; un panneau montre le score de chaque
  itération, la cible, le rendu, la carte des différences et les écarts restants. En hors-ligne
  strict, seule une vision locale (Ollama) est utilisée.
- **L'app de bureau se connecte à un serveur d'équipe par n'importe lequel de ses fournisseurs
  d'identité, et montre comment la session a été ouverte** (#363). Le bouton Microsoft Entra ID
  passe désormais par le même flux OpenID Connect que Okta, Google Workspace, Keycloak ou Auth0
  (PKCE, `state` et `nonce`, retour sur la boucle locale), avec les mêmes contrôles. Une nouvelle
  page des réglages, « Ma session sur le serveur », dit qui est connecté, par quoi (mot de passe,
  Entra, fournisseur et hôte de son émetteur, invitation) et depuis quand, et permet de se
  déconnecter ; le serveur le donne par `GET /auth/me/session` et garde dans son journal le
  fournisseur de chaque connexion.
- **Vagues d'exécution d'un projet du serveur dans l'app de bureau** (#358) : connectée à un
  serveur d'équipe, Mission Control montre pour un projet du serveur ses vagues telles que le
  serveur les planifie depuis son clone, l'exécution en cours (colonne de chaque carte, ou ce
  qu'elle attend), le lancement de la première vague, « Vérifier maintenant » et l'arrêt, ainsi
  que les chiffres des 14 derniers jours (exécutions, conflits évités, conflits de fusion résolus
  et leur temps médian mesuré, conflits encore ouverts), comme la page « Vagues » de l'app mobile.
  Les boutons suivent les droits de la personne ; le serveur les revérifie. Rien n'est estimé.
- **Vagues d'exécution : merge de test, reprise après redémarrage, zones fragiles** (#358, lot 2).
  Deux specs d'une même vague qui partagent des fichiers sous la tolérance et ont chacune un
  worktree passent par un merge de test (`git merge-tree`, sans toucher aux worktrees ni aux
  branches) : un vrai conflit les place dans des vagues différentes et la vue dit sur quels
  fichiers. L'exécution « dans l'ordre optimal » est enregistrée dans le `.workpilot/` du projet à
  chaque étape : après un redémarrage, la vue propose de la reprendre ou de l'abandonner. Les
  fichiers que l'historique git modifie souvent ensemble (un dans chaque spec) s'ajoutent au score,
  avec une option pour les désactiver. Toutes les stacks, aucun modèle appelé.
- **Vagues d'exécution : liens de code et historique des exécutions** (#358, lot 3). Le score
  d'une paire de specs compte aussi les imports croisés (un fichier d'une spec importe un module
  que l'autre modifie) et les symboles supprimés ou renommés par une spec qu'un fichier de l'autre
  utilise encore, lus depuis le code et le diff du worktree, de la même façon dans tous les
  langages, avec une option pour les désactiver. Chaque exécution « dans l'ordre optimal »
  terminée ou arrêtée est consignée dans le `.workpilot/` du projet, et la vue résume les
  14 derniers jours : exécutions, conflits évités, risque retiré, specs lancées. Aucun modèle
  appelé, aucune durée estimée.
- **Vagues d'exécution sur un serveur d'équipe et sur mobile** (#358, lot 4) : le serveur
  planifie le backlog d'un projet depuis son clone, avec le même calcul que le bureau (fichiers
  partagés, zones fragiles, liens de code, merge de test), et mène lui-même « Exécuter dans
  l'ordre optimal » : il lance chaque carte comme le tableau, au nom de la personne qui a démarré
  l'exécution et seulement tant qu'elle en a le droit, et passe à la vague suivante quand un run
  du projet se termine. L'exécution et son historique vivent dans le clone. L'app mobile a une
  page « Vagues » par projet : plan, exécution en cours, démarrage, arrêt et chiffres du sprint.
- **Temps de résolution des conflits résiduels** (#358, lot 4) : un merge (ou son aperçu) qui
  rencontre un conflit git en note l'heure, le merge suivant de la tâche qui aboutit note celle de
  la résolution, sur le bureau comme sur le serveur. La vue des vagues et l'app mobile montrent,
  sur 14 jours, les conflits résolus, leur temps médian mesuré et ceux encore ouverts. Rien n'est
  estimé.
- **Vagues d'exécution entre specs** (#358, lot 1) : dans Mission Control, les specs du backlog et
  de la file sont regroupées en vagues qui ne partagent aucun fichier, d'après leurs plans et ce
  que leurs worktrees ont déjà modifié, quelle que soit la langue (un manifeste de dépendances ou
  un lockfile pèse plus). Plan vague par vague, ordre de merge, paires les plus risquées, cycles
  de dépendances signalés, dérive d'une spec hors de son plan. « Exécuter dans l'ordre optimal »
  lance chaque vague par le démarrage habituel des tâches (chaque tâche avec son provider), dans
  la limite des tâches parallèles du projet, et replanifie le reste à chaque vague. Aucun modèle
  n'est appelé.
- **Voie express pour les PR de dépendances.** Dans Réglages, Validation par niveaux, un nouvel
  interrupteur (arrêté par défaut) laisse fusionner seules les pull requests Dependabot et
  Renovate de vos projets quand leur niveau est N0 et que tous leurs checks sont passés.
  Environ toutes les demi-heures, pour chaque projet local sur GitHub, et seulement quand les
  niveaux sont appliqués. Une montée majeure, un changement de code ou de CI, un check rouge ou
  en cours, un brouillon ou un fork reste à une personne.
- **Comptes des forges** : enregistrez une fois plusieurs comptes GitHub, GitLab, Azure DevOps et
  Bitbucket (travail, perso, client, instance GitLab auto-hébergée) dans Réglages, Comptes des
  forges, avec un test de connexion. Chaque projet choisit le compte qu'il utilise dans ses réglages
  GitHub, GitLab ou Azure DevOps, ou garde son propre jeton. Les jetons restent chiffrés dans l'app
  et ne vont qu'à l'adresse pour laquelle ils ont été enregistrés.
- **Routage OpenRouter et Hugging Face.** La page OpenRouter règle jusqu'à trois modèles de
  secours, essayés dans l'ordre quand le modèle par défaut est indisponible, l'ordre des
  fournisseurs (le moins cher, le plus rapide, la latence la plus basse) et deux filtres de
  confidentialité : seulement les fournisseurs qui ne conservent pas les prompts, ou sans aucune
  conservation. La page Hugging Face choisit le fournisseur le plus rapide ou le moins cher.
- **Gouvernance des agents dans `workpilot.policy.yaml`** (#353) : la politique versionnée du dépôt fixe les heures où les agents travaillent (fuseau explicite, plages de nuit, jours), les fichiers qu'ils ne touchent jamais et ceux qui attendent une revue, et un budget de jetons par heure pour tout le projet, sur tous les fournisseurs. Hors des heures ou au budget atteint, la tâche se met en pause et sa carte dit pourquoi ; un fichier invalide refuse toute écriture et toute commande. Chaque décision (refus, revue, approbation, avertissement, hors horaires, budget atteint, politique invalide) est inscrite dans un journal d'audit borné, que Réglages → Garde-fous affiche en lecture seule avec la politique active et ses erreurs, et exporte en CSV ou JSON.
- **La gouvernance d'un projet du serveur, dans l'app et sur le téléphone** (#353) : Garde-fous
  d'un projet du mode serveur montre ce que le serveur lit dans son `workpilot.policy.yaml`, les
  appels qu'attendent ses agents (Approuver, Refuser), ses agents en cours avec leur arrêt, et ses
  dernières décisions, exportables ; le téléphone a la même page, sauf l'export. Une approbation
  est donnée au nom du compte connecté et de ses rôles, et le journal l'écrit ; le nouveau
  `files.reviewers` réserve l'approbation à certains rôles. Sur l'ordinateur seul, le panneau dit
  qu'une approbation n'a pas d'identité vérifiée.
- **« Arrêter tous les agents » atteint aussi le serveur** (#353) : en mode serveur, l'appui arrête
  en plus les runs et les jobs que la personne a lancés sur chaque projet du serveur, jamais ceux
  d'un collègue ; le propriétaire d'un projet peut y tout arrêter. Un test sur de vrais processus
  exige que l'arrêt prenne moins de 2 s.
- **Les noms de fuseau marchent sous Windows** (#353) : le backend embarque `tzdata`, donc
  `schedule.timezone: Europe/Paris` n'est plus refusé là où le système n'a pas de données de fuseau.
- **La gouvernance tient aussi le Swarm, la tâche et le coupe-circuit** (#353) : avant chaque
  vague et chaque nouvel essai, le Swarm relit la pause de la tâche et `workpilot.policy.yaml` ;
  hors des heures, au budget atteint ou quand un agent s'est mis en pause, rien de nouveau ne
  démarre et ce qui était fini est gardé. Une politique invalide met la tâche en pause avant toute
  session, avec la liste des erreurs dans son journal et une carte qui le dit. Deux réglages
  rejoignent le fichier : `budget.max_tokens_per_task` (jetons d'une tâche, toutes sessions) et
  `loop_detection.max_same_tool_call` (limite du coupe-circuit, que le réglage de la machine ne
  peut que durcir). Chaque déclenchement du coupe-circuit entre dans le journal d'audit, et
  Réglages → Garde-fous compte les actions arrêtées sur 24 h et les déclenchements sur 7 jours.
- **« Essayer dans le cloud » dans la recherche de modèles Hugging Face.** Un modèle du Hub que
  Hugging Face sert en ligne affiche son prix et un bouton qui en fait le modèle du fournisseur
  Hugging Face : on l'essaie sur une tâche avant d'en télécharger des gigaoctets. Les pages
  OpenRouter et Hugging Face affichent leur catalogue en direct (prix, contexte) ; un clic choisit
  le modèle par défaut, que chaque tâche reprend.
- **Le triage des issues repère les doublons par le sens.** Avec un jeton Hugging Face (ou une clé
  OpenAI ou Voyage), le triage montre au modèle les issues ouvertes les plus proches par le sens,
  avec leur score de similarité, et non plus seulement celles dont le titre partage des mots. Sans
  clé, ou si le service ne répond pas, rien ne change. Réglage : `ISSUE_EMBEDDINGS_PROVIDER`.
- **« Interroger le tableau » : une question, tous les tickets qui s'y rapportent.** Le bouton
  **Interroger** de la barre du Kanban ouvre une conversation : « Comment a été revue la page
  d'admin ? » ressort chaque ticket lié, terminés, archivés et abandonnés compris, même rédigés
  dans une autre langue que la question. L'IA du provider choisi (n'importe lequel) traduit la
  question dans les langues du tableau, une recherche par mots-clés trouve les candidats, puis
  l'IA dit pour chacun s'il couvre déjà le sujet, en partie ou seulement de loin, et répond en
  citant les tickets ; un clic ouvre le ticket. Sans IA, la recherche par mots-clés répond seule.
  Rien n'est enregistré.
- **« Interroger le tableau » comprend le sens, d'une langue à l'autre.** Quand un modèle
  d'embeddings est là, les tickets sont aussi classés par le sens de la question : « admin page
  review » trouve « Revisión del panel de administración » sans un mot en commun, même sans
  réponse de l'IA. Le modèle de cet ordinateur d'abord (Ollama, LM Studio, par exemple `bge-m3`),
  sinon l'API d'embeddings du provider choisi (OpenAI, Mistral, Google, Hugging Face) ; jamais
  d'API sous le mode hors-ligne strict. Le réglage **Par le sens** du panneau choisit Auto, Cet
  ordinateur seulement ou Désactivé. Les vecteurs restent sur cet ordinateur, pour qu'une question
  suivante n'envoie que les tickets qui ont changé.
- **« Interroger le tableau » sur le téléphone.** L'app mobile a une page **Interroger le tableau**
  (onglet *Plus*) : posez une question dans n'importe quelle langue, le serveur répond avec les
  cartes, les fonctionnalités de la roadmap et les idées qui s'y rapportent, avec le provider IA du
  projet. Il suffit du droit de lire le tableau ; vous seul voyez vos questions et leurs réponses.
- **« Interroger le tableau » sur un tableau du serveur.** En mode serveur, le bouton **Interroger**
  et l'onglet « Vérifier une idée » marchent aussi sur un projet du serveur : ils lisent les cartes
  que le serveur vous montre, selon vos droits, et répondent avec votre provider IA, comme sur un
  projet local.
- **« Interroger le tableau » lit aussi la roadmap, les idées et l'historique.** Une question ou
  une idée à vérifier trouve désormais les fonctionnalités de la roadmap, les idées d'Ideation et
  les changements déjà fusionnés dans la branche du projet (PR squashées ou commits de merge),
  chacun marqué comme tel : une fonctionnalité prévue n'est pas comptée comme faite, un
  changement fusionné l'est. Le menu **Sources** du panneau choisit ce qui est lu en plus des
  cartes.
- **Kanban : archivage auto et « Mes tâches »**. Un nouveau réglage archive les tâches terminées
  depuis 7, 14 ou 30 jours (éteint par défaut, projets locaux) ; elles restent visibles avec
  « Afficher les archivées ». Sur un tableau du serveur, le filtre rapide « Mes tâches » ne garde que
  les tâches que tu tiens.
- **Cartes Kanban colorées par type** : chaque carte prend la couleur de son type (14 types :
  fonctionnalité, UI/UX, bug, correctif urgent, sécurité, performance, refactoring, tests,
  investigation, spike, documentation, exploitation, montée de version, infra), déduit de ce
  que la carte porte déjà (type de travail, catégorie, sévérité, élément importé, origine).
  Une lueur dans le coin haut-droit et un liseré en haut ; le liseré gauche garde la couleur
  de la colonne. Une seule pastille de type remplace les deux badges qui se recouvraient. Une
  carte bloquée est hachurée, une carte terminée ou au type seulement proposé est plus pâle,
  et le texte reste lisible (AA) sur les 7 thèmes en clair et en sombre.
- **Fiche au survol d'une carte** : après 700 ms sur une carte (ou au focus clavier), une fiche
  montre le type et ce qui l'a décidé, le titre complet, plus de description, la
  classification, l'état et ce qui bloque, l'origine, le moteur et la dernière activité.
- **« Vérifier une idée » dans « Interroger le tableau ».** Collez une fonctionnalité prévue, dans
  n'importe quelle langue : elle est découpée en exigences, chacune cherchée dans tous les tickets
  (par les mots et par le sens) puis jugée **Déjà fait**, **En partie** ou **Manquant**, avec les
  tickets qui la portent. Un clic crée une carte du backlog qui ne garde que ce qui reste à faire,
  avec les tickets sur lesquels s'appuyer. Sans modèle, les exigences sont listées « À vérifier »
  avec leurs tickets les plus proches.
- **Colonnes du Kanban en bandeau** : chaque colonne porte un en-tête teinté de sa couleur avec
  une icône, un gros compteur et une jauge de capacité (créneaux d'« En cours », limite WIP) qui
  passe à l'ambre quand elle est pleine ou dépassée. L'état vide, la colonne repliée et la cible
  de dépôt prennent la couleur de la colonne, qui suit désormais le thème au lieu d'un jaune fixe.
  Le texte du bandeau reste lisible (4,5:1) sur les 7 thèmes, en clair comme en sombre.
- **Résumé sous le titre des colonnes du Kanban** : une ligne dit ce que contient chaque colonne
  sans ouvrir de carte : cartes urgentes de « À faire », prochaine carte de la file, phase des
  agents d'« En cours », plans à approuver et cartes à corriger en revue, cartes terminées cette
  semaine. Les alertes sont en ambre. Se masque dans Paramètres › Affichage.
- **Clic droit sur les cartes et les colonnes du Kanban** : une carte offre au clic droit, comme
  dans son menu « ⋮ », Ouvrir, Modifier… (le dialogue d'édition s'ouvre directement), Type ▸,
  Priorité ▸, Déplacer vers ▸, Estimer, Dupliquer, Pause ou Reprendre, Synchroniser depuis la
  branche et Supprimer. Une colonne offre au clic droit Ajouter une carte et ses actions (tout
  sélectionner, tout mettre en file, archiver, verrou, repli). Type, priorité et texte restent
  grisés tant qu'un agent travaille sur la carte.
- **Kanban : marquer une carte « Bloquée »**. Comme le drapeau de Jira, la carte garde sa colonne et
  montre un bandeau rouge avec la raison ; aussi en mode serveur et dans l'app mobile.
- **Kanban : une carte dont la PR est fermée sans fusion passe seule dans « Abandonnée »** (résolution
  « PR fermée sans fusion »). Le réglage Affichage « Mettre de côté les cartes dont la PR est
  fermée » le désactive.
- **Kanban, glisser plusieurs cartes** : glisser une carte sélectionnée emporte toute la
  sélection, même prise dans plusieurs colonnes. Chaque carte suit les règles d'un glisser seul :
  En cours démarre ce que ses places libres permettent et le reste attend dans File d'attente,
  PR ouverte ne prend que les cartes qui ont une PR. La pile sous le pointeur montre le nombre de
  cartes, et un seul Ctrl+Z annule le déplacement. La barre d'actions respecte aussi la limite
  d'En cours.
- **Kanban au clavier** : un double-clic sur le titre d'une carte, ou F2, la renomme sur place
  (Entrée enregistre, Échap annule, Ctrl+Z revient en arrière). Les flèches passent d'une carte à
  l'autre, dans la colonne et d'une colonne à l'autre, et le lecteur d'écran dit où l'on est.
  Ctrl+/, « ? » ou le nouveau bouton clavier de la barre d'outils affichent la liste des touches
  du tableau.
- **Kanban : étiquettes et filtres rapides**. Le menu d'une tâche propose « Étiquettes… » ; les
  étiquettes s'affichent sous son titre et filtrent le tableau d'un clic. Le panneau « Filtres »
  gagne « Bloquées » et « Modifiées cette semaine », et un filtre par étiquette. En local comme en
  mode serveur.
- **Kanban : vue liste**. La bascule « Tableau / Liste » de la barre d'outils montre les tâches en
  liste : statut, priorité, sprint, sous-projet, points et dernière modification, triables par
  colonne et regroupées par les couloirs choisis. Les vues enregistrées gardent maintenant aussi
  l'affichage, les couloirs et le tri de la liste.
- **Colonnes « Échec » et « Abandonnée » sur le Kanban.** Un run fini en erreur, refusé par la QA
  ou à court de contexte va dans « Échec », d'où il ne repart que vers le travail. Glisser une
  tâche (ou une sélection) dans « Abandonnée » demande pourquoi, comme dans Jira : ne sera pas fait,
  doublon, obsolète, remplacée par une autre tâche, autre, avec la tâche liée et une note. La
  ressortir la reprend. Les deux colonnes n'apparaissent que si elles ont une tâche, et se voient
  aussi en mode serveur et sur l'app mobile.
- **Ajouter des cartes sans quitter le tableau** : Planification et File d'attente ont une boîte
  d'ajout rapide, ouverte par le « + », la ligne « Ajouter une carte » sous les cartes, un
  double-clic dans le vide de la colonne ou la touche N. Entrée crée la carte et laisse la boîte
  ouverte pour la suivante ; une liste collée crée une carte par ligne ; type et priorité se
  choisissent dans la boîte ; « Plus d'options… » ouvre l'assistant complet déjà rempli. Une carte
  ajoutée dans File d'attente démarre dès qu'un emplacement se libère.
- **Kanban : rapports**. Le bouton « Rapports » de la barre d'outils montre le burndown du sprint
  en cours, la vélocité des sprints terminés, le flux cumulé des 30 derniers jours, le temps de
  cycle (médiane et 85e centile), le débit par semaine et les fins non abouties (échecs par raison,
  abandons par résolution). Tout est mesuré sur ce qui s'est passé, jamais estimé.
- **Une tâche terminée dit ce qu'elle a coûté, combien de temps elle a pris et qui l'a faite.**
  Sous le titre d'une carte finie (terminée, PR ouverte ou revue des agents achevée) : le temps de
  travail des agents, les tokens et le coût de toutes leurs sessions, quel que soit le
  fournisseur, et la personne qui a créé la tâche puis celle qui l'a lancée, quand ce ne sont pas
  les mêmes. L'aperçu au survol détaille le délai du lancement à la fin, l'entrée, la sortie et le
  cache, les modèles et les sessions estimées. Ce qu'aucun fournisseur n'a compté s'affiche
  « inconnu », jamais 0. En local, le nom est celui de l'identité git ; en mode serveur, le nom
  d'affichage du compte, lu à chaque instantané.
- **Sélectionner et défaire vite sur le Kanban** : Ctrl+clic (Cmd+clic) ajoute une carte à la
  sélection, Maj+clic sélectionne une suite de cartes, Ctrl+A toute la colonne, Échap vide la
  sélection et Suppr la supprime. La barre d'actions change aussi le type et la priorité de toute
  la sélection, comme le clic droit sur une carte sélectionnée. Une carte sur laquelle rien n'a
  encore travaillé se supprime sans confirmation : elle disparaît et « Annuler » la ramène
  pendant 8 secondes. Ctrl+Z annule les 20 dernières modifications (type, priorité, déplacement
  entre Planification et File d'attente, suppression en attente). La case à cocher des cartes
  n'apparaît plus qu'au survol ou pendant une sélection.
- **Kanban : sprints**. Le bouton « Sprints » crée des sprints (nom, objectif, dates), les
  démarre (un seul en cours à la fois) et les termine en envoyant les tâches non finies vers un
  sprint planifié ou le backlog. Il filtre le tableau par sprint ou backlog et montre la
  progression en tâches et en points (le score de l'estimation intelligente) et la vélocité des
  derniers sprints. Une tâche rejoint un sprint par son menu ou en la glissant dans le couloir du
  sprint. En local comme sur un projet du serveur, où les sprints sont partagés par l'équipe.
- **Kanban, créer une carte dans En cours** : la colonne a maintenant son « + » et sa ligne
  « Ajouter et démarrer ». La carte créée démarre aussitôt tant qu'une place est libre ; sinon
  elle attend dans File d'attente, et le message le dit.
- **Pré-analyse avant En cours** : avant qu'une carte démarre pour la première fois, l'app
  vérifie que le projet est un dépôt git avec un commit et que le compte Claude est connecté,
  au lieu d'échouer une fois la carte déplacée. Une carte courte (un titre, peu de description)
  est relue par l'IA, qui peut poser jusqu'à trois questions ; les réponses s'ajoutent à la
  description, et « Démarrer quand même » reste possible. Sans réponse du modèle, la carte démarre.
- **Chaque carte du Kanban garde l'historique de ses statuts.** Chaque passage d'une colonne à
  l'autre est noté à côté de la tâche (`status_history.json`) avec sa date et qui l'a fait : les
  agents, une personne, ou l'app elle-même (PR fusionnée, CI réparée). En mode serveur, le compte
  de la personne est noté par son seul identifiant, jamais son nom. C'est la base des futurs
  rapports agiles (temps de cycle, diagramme de flux, burndown).
- **Kanban : couloirs (swimlanes)**. Le bouton « Couloirs » coupe le tableau en lignes par priorité,
  type, sous-projet, origine ou tâche découpée, chaque ligne avec toutes les colonnes. Glisser une
  carte dans un autre couloir change sa priorité, son type ou son sous-projet (Ctrl+Z l'annule), en
  local comme sur un projet du serveur ; les cartes « Bloquées » peuvent avoir leur couloir, en
  premier. Les sous-projets viennent de l'index du projet ou s'ajoutent par leur nom.
- **Kanban : frise**. La bascule d'affichage propose aussi « Frise » : une barre par tâche, du
  début du travail à sa fin (ou à aujourd'hui tant qu'elle est en cours), avec les semaines et les
  dates des sprints en tête, et une section par couloir.
- **Barre d'outils du Kanban sur une seule ligne** : « Multi-dépôts » et « Purger » passent dans
  un menu « ⋯ » au bout de la barre, avec une phrase qui dit à quoi chacun sert. La recherche,
  les filtres, les vues et la commande rapide tiennent sur une ligne dès 1 280 px de large, et
  les colonnes gagnent la hauteur d'une ligne.
- **Analyse du code des serveurs MCP** : en ouvrant les détails d'un serveur du catalogue, l'app
  lit l'archive publiée par npm ou PyPI pour la version lancée (vérifiée par son empreinte, lue en
  mémoire, jamais exécutée) et y cherche ce qui lance des programmes, exécute du code construit à
  la volée, contient une chaîne en forme d'identifiant, écrit des fichiers ou ouvre le réseau. Le
  score gagne une dimension « Code source », qui compare aussi ce que le code fait avec ce que
  ses outils déclarent ; un code introuvable ou illisible ne peut pas être audité et le dit. La
  revérification quotidienne alerte quand une nouvelle version apporte un de ces motifs.
- **Constats acceptés** : `.workpilot/mcp-policy.json` accepte `acceptedFindings`, un constat
  examiné par l'équipe avec sa raison, qui ne coûte plus de points et s'affiche avec elle.
- **Outils des agents** : un serveur MCP refusé par la politique du projet dit désormais pourquoi.
- **Serveurs MCP confinés** (#369) : un serveur MCP personnalisé peut tourner confiné, dans le bac à sable de l'OS, avec seulement les hôtes qu'il liste sur le réseau (plus le registre d'où il s'installe) et des écritures limitées au projet. Une case « Exécuter confiné » le règle dans la fenêtre du serveur ; une politique de projet (`confineBelow` dans `.workpilot/mcp-policy.json`) confine d'office les serveurs dont le score de sécurité est sous le seuil et ceux hors catalogue. Le confinement vaut pour tous les fournisseurs (SDK Claude, Codex, OpenCode, agents ACP, modèles OpenAI, Google, compatibles et locaux) ; là où le bac à sable manque (Windows, bubblewrap absent), un serveur confiné ne démarre pas.
- **Alertes sur les serveurs MCP installés** : une fois par jour, l'app relit le registre et les
  vulnérabilités connues des serveurs du catalogue installés dans vos projets, et la liste des
  serveurs installés signale ce qui a empiré depuis la dernière lecture : nouvel avis de
  vulnérabilité pour la version lancée, nouveau mainteneur, paquet déprécié ou retiré, score
  tombé sous 50. Chaque alerte s'acquitte. Un serveur ajouté à la main est marqué « non
  vérifiable » et n'est jamais lu sur le réseau ; rien n'est lu pour un projet en hors-ligne strict.
- **Liste blanche MCP d'entreprise** : un fichier `.workpilot/mcp-policy.json` facultatif limite
  ce qui peut être installé dans le projet (serveurs du catalogue autorisés, score de sécurité
  minimum, serveurs hors catalogue interdits). Elle s'applique à l'enregistrement des réglages du
  projet ; une installation refusée dit pourquoi, et un fichier invalide bloque toute installation
  en le signalant.
- **Score de sécurité des serveurs MCP** : chaque carte du Marketplace MCP affiche un score sur
  100 (éditeur, permissions des outils, exécution locale et version épinglée, date de la
  dernière version, vulnérabilités connues via OSV, changement de mainteneurs). Les détails de la
  carte disent d'où vient chaque point et signalent un paquet déprécié, peut-être abandonné ou
  dont un mainteneur est apparu. Rien n'est lu sur le réseau pour un projet en hors-ligne strict.
- **Avis de l'équipe sur les serveurs MCP** : dans un projet du serveur, chaque membre laisse sur
  un serveur du catalogue du Marketplace MCP un avis (sûr, à utiliser avec prudence, dangereux) et
  un commentaire, lus par les membres du projet sous le score de sécurité. Écrire un avis demande
  la nouvelle permission `marketplace.write` (contributeurs, relecteurs et au-dessus) ; l'auteur
  ou le propriétaire du projet le supprime.
- **La mémoire d'un projet s'explique** (#348). Chaque décision — mémoire créée, modifiée,
  oubliée, restaurée, épinglée, fusionnée, archivée — est une ligne d'un journal en clair rangé
  dans le cerveau partagé, avec son auteur (toi, un agent, la synchronisation, le learning loop)
  et sa raison ; chaque mémoire a son historique. « Oublier » met la note à la corbeille pendant
  30 jours, d'où **Restaurer** la remet en place (avec un avertissement si elle contredit une
  mémoire actuelle) ; **Épingler** (50 par projet) la protège de toute suppression automatique.
  Nouvel onglet **Cycle de vie** dans Contexte, actions sur chaque mémoire de l'onglet Mémoires.
- **Les contradictions apportées par une synchronisation d'équipe sont détectées** (#352).
  Une note reçue qui contredit une note du projet (« toujours » contre « jamais », deux valeurs
  pour le même réglage, deux recommandations opposées) est repérée sans modèle, hors ligne et pour
  tous les fournisseurs. Les cas sûrs se règlent seuls (la note épinglée, le pattern le plus sûr,
  la note bien plus récente l'emporte) ; les autres attendent côte à côte : garder l'une, écrire la
  note canonique, ou dire que ce n'est pas un conflit. Les variantes sont archivées et liées à la
  note retenue, et un modèle peut donner son avis sur demande, sans jamais trancher.
- **Le cycle de vie de la mémoire d'un projet du serveur** (#348). L'onglet **Cycle de vie** et
  les actions Épingler, Oublier, Portée et Historique marchent aussi pour un projet du serveur, sur
  sa propre mémoire : chaque membre lit le journal et la corbeille, et quiconque peut écrire les
  insights du projet décide pour l'équipe ; le journal le nomme.
- **Séparer deux patterns que le learning loop a fusionnés** (#348). Le pattern plié dans un
  autre est gardé 30 jours : **Annuler** dans l'heure, puis **Séparer** depuis le journal, le
  remettent comme pattern à lui et retirent sa part (occurrences, builds, confiance) de l'autre.
- **Annuler une décision de la mémoire, séparer une fusion** (#348). L'onglet **Cycle de vie**
  propose d'annuler la dernière décision automatique de l'heure (une mémoire retirée par un agent
  ou le learning loop, une variante écartée par une synchronisation) ; chaque fusion du journal a
  son bouton **Séparer**, qui remet la variante à sa place et redemande à une personne de
  trancher — une note de consensus se sépare en entier. L'onglet montre aussi comment le cycle de
  vie se comporte : restaurations de la semaine (avec un avertissement s'il retire trop), taux
  d'épingles, conflits réglés par les règles ou par une personne, temps moyen avant décision.
- **Une mémoire portée sur une branche ou une équipe n'est rappelée que là où elle s'applique** (#352). Une note `branch:release/2.0` n'est servie qu'aux agents d'une tâche de cette branche (ou d'une branche en dessous, comme `branch:release` pour `release/2.0`), jamais quand la branche ne se lit pas ; en mode serveur, une note `team:paiements` ne l'est qu'aux runs lancés par un membre du groupe « paiements ». En local, les notes d'équipe restent servies à tous, et les notes sans portée ne changent pas. L'onglet Mémoires, le Cycle de vie et l'historique montrent toujours chaque note avec sa portée.
- **L'équipe apprend qu'un conflit de mémoire l'attend** (#352). Sur demande, par projet
  (Réglages du projet → Notifications), un conflit qu'une synchronisation met en file est annoncé
  sur les canaux du projet (Teams, Slack, Discord, Google Chat, webhook) : les deux titres, un
  court aperçu nettoyé et le nom des auteurs, jamais un e-mail ni une mention. Chaque paire n'est
  annoncée qu'une fois pour toute l'équipe, et rien ne part en mode hors ligne strict.
- **Mainteneurs par portée, portées d'équipe et de branche** (#352). La **Portée** d'une mémoire
  peut nommer une équipe (`team:paiements`) ou une branche git (`branch:release/2.0`) en plus
  d'un module. Chaque portée peut avoir ses mainteneurs : la liste la plus précise tranche une
  paire escaladée. Le Cycle de vie compte aussi les notes de consensus écrites en 30 jours et
  celles encore en usage.
- **Les règles d'une équipe sur la mémoire partagée** (#352). Une décision sur un conflit porte
  le nom de la personne qui l'a prise (la carte **Décisions** du Cycle de vie les liste). Une paire
  de notes tranchée il y a moins de 7 jours qui se contredit de nouveau n'est plus réglée
  automatiquement : elle est escaladée aux **mainteneurs** que l'équipe désigne dans l'onglet
  (sans mainteneur, n'importe qui tranche). Chaque mémoire a une **Portée** (la partie du code où
  elle s'applique) : deux notes de portées différentes ne sont plus signalées comme
  contradictoires.
- **Un menu arrangé par chacun** : une page glissée sur un autre espace du rail y passe, les
  épingles de « Mon menu » se réordonnent par glisser-déposer, et « Personnaliser le menu » offre
  les mêmes déplacements en boutons (monter, descendre, déplacer vers un espace, déplacer l'espace
  dans le rail) pour la souris comme pour le clavier, avec « Rétablir l'ordre d'origine » qui garde
  les épingles et les pages masquées. Les glissers sont annoncés aux lecteurs d'écran en français
  et en anglais.
- **Mode serveur** : le menu ainsi arrangé est celui de la personne connectée et la suit sur
  chacun de ses postes (`GET/PUT /users/me/preferences/menu`), comme son thème.
- **Mission Control compose l'équipe** (#344). L'onglet « Composition automatique » du dialogue
  d'ajout propose une équipe d'agents d'après une description, la spec d'une tâche ou un modèle de
  session (correction de bug, nouvelle fonctionnalité, refonte de module, réponse à incident), sur
  les providers choisis et mélangés, avec des modèles filtrés par leurs capacités. Sous un budget en
  dollars ou en tokens, elle propose une équipe moins chère et dit ce qu'elle économise ; un budget
  trop bas est refusé avec ce que demande la plus petite équipe. Un modèle rapide du premier
  provider peut donner un second avis.
- **Mission Control lance un agent d'appoint à côté d'un agent bloqué** (#344). Quand le
  rééquilibrage n'a plus rien à tenter, un débogueur sur le modèle le plus puissant de l'équipe
  cherche pourquoi la tentative a échoué et fait la tâche, sur sa propre carte, une fois par tâche
  et jamais au-delà du budget. Une boucle se lit aussi dans l'arbre de décision (les mêmes appels
  d'outils ou les mêmes réflexions, encore et encore). Un modèle Ollama local qui n'appelle pas
  d'outils, d'après le serveur lui-même, n'est plus proposé pour lire du code ; les modèles de
  session sont vérifiés en CI contre un Ollama local, sans réseau.
- **Mission Control rééquilibre un agent bloqué** (#344). Un agent dont le provider est limité
  ou indisponible passe au provider suivant de l'équipe (un autre profil Claude d'abord, quand il y
  en a un) ; un agent qui échoue ou dont la réponse tourne en boucle passe à un modèle plus
  puissant ; la même tâche repart aussitôt, deux fois au plus, jamais au-delà du budget. Chaque
  décision s'affiche dans le journal et sur la carte, et une case coupe le rééquilibrage. La
  session affiche ce qu'elle a dépensé contre son budget, et un historique mesure la part des
  sessions composées automatiquement, les tokens des équipes automatiques contre les manuelles,
  les rééquilibrages et les budgets dépassés ; les estimations de tokens par rôle s'en calibrent.
- **App mobile, l'administration** : la vue d'ensemble de l'organisation (agents en cours, semaine, derniers échecs, usage des quotas), les quotas à lire et modifier, le journal d'audit filtrable par action et les sessions de chaque membre, avec « Déconnecter partout ». Les adresses IP ne sont pas affichées sur le téléphone.
- **Mes comptes IA sur le téléphone** (mode serveur). **Réglages → Mes comptes IA** montre vos
  comptes de chaque fournisseur IA sur le serveur et le compte par défaut que vos runs utilisent ;
  un appui en choisit un autre, ou revient au compte du serveur. Selon votre rôle, l'écran ajoute un
  compte (pour Claude, un jeton de `claude setup-token`), le renomme, remplace sa clé ou le
  supprime ; une clé envoyée n'est jamais réaffichée.
- **App mobile, tableau plus rapide** : une recherche (titre, numéro, qui a pris la carte, sans se soucier des accents) et des filtres (mes cartes, types de carte) au-dessus des colonnes ; un appui long sur une carte propose ses actions immédiates (démarrer, approuver la spec, arrêter, relancer le build) sans l'ouvrir ; un léger retour haptique ; et sur tablette, toutes les colonnes côte à côte.
- **App mobile, la carte en profondeur** : tout le journal d'une carte en plein écran, en direct pendant que l'agent travaille (par phase, les erreurs seules, sans les outils, recherche par mots), chaque fichier modifié en plein écran avec ses numéros de ligne, l'avis de l'équipe sur chaque constat de la revue IA d'une PR GitHub (utile ou pas, et pourquoi ; un mainteneur tranche les rejets mis de côté), et la mémoire du projet à épingler, oublier ou remettre depuis la corbeille.
- **App mobile, « Pour vous »** : la liste des projets dit combien de cartes vous attendent, et un écran les rassemble de tous vos projets, rangées par ce qu'il y a à faire (plan à approuver, run arrêté à regarder, travail terminé à relire). Seules les cartes sur lesquelles votre rôle peut agir y sont, sauf celles qu'une autre personne a réservées.
- **App mobile, « Me prévenir ailleurs »** : dans les réglages, vos canaux ntfy, Telegram et Teams sur le serveur, les moments dont vous êtes prévenu et la langue des messages, avec un envoi de test. Les secrets ne reviennent jamais sur le téléphone.
- **L'app mobile montre comment sa session a été ouverte** (#363). Les Réglages ont une section
  « Ma session » : qui est connecté, avec quoi (mot de passe, Microsoft Entra ID, la connexion unique
  du serveur avec son nom, une invitation), le fournisseur d'identité et l'heure de la connexion,
  comme la page du bureau. L'app ne garde que des champs bornés de la réponse du serveur ; le bouton
  de déconnexion reste au bas des Réglages.
- **Mon usage sur le téléphone.** Dans Réglages, chacun voit ce que les administrateurs de son
  organisation voient de lui sur 30 jours (jetons, coût, runs, jobs, chronologie, écrans ouverts),
  quels rôles le lisent, partage en JSON tout ce que le serveur garde sur lui et relit ce qui est
  mesuré. Le message de ce qui est mesuré s'affiche une fois par organisation, et sa lecture est
  inscrite à l'audit.
- **App mobile, l'équipe** : le chat d'équipe d'un projet en direct (qui est là, l'historique, répondre à un message ; un lecteur lit sans écrire), le classement de l'équipe sur le projet ou l'organisation, où seuls ceux qui l'ont accepté sont nommés (le choix, désactivé par défaut, se règle depuis le téléphone), et « Mes liens de replay » dans les réglages pour voir et arrêter les replays partagés.
- **L'app mobile refaite** : chaque projet s'ouvre sur une barre d'onglets (tableau, Insights, forge, tableau de bord, « Plus » pour les autres pages, chacune avec ce à quoi elle sert), des icônes partout, des cartes plus lisibles (type, avancement, qui l'a prise, il y a combien de temps), un bouton « Nouvelle carte » flottant, des chiffres clés en tête du tableau de bord, des états vides illustrés, et dans les réglages un profil et un choix de thème en aperçu (chaque thème montré comme un petit tableau). La capture du README garde enfin les proportions d'un téléphone et montre quatre thèmes.
- **OpenRouter et Hugging Face deviennent de vrais fournisseurs.** Une seule clé donne accès aux
  modèles ouverts et fermés de nombreux éditeurs (Kimi, GLM, DeepSeek, Qwen, Claude, GPT…), pour
  toutes les phases d'une tâche et dans le basculement automatique. La liste des modèles se lit en
  direct, même sans clé, et ne garde que ceux qui savent appeler des outils, avec leur prix et leur
  fenêtre de contexte. La clé se règle dans Paramètres → Comptes IA ; le jeton Hugging Face
  (`HF_TOKEN`) est reconnu tel quel.
- **Pair Programming : un vrai participant IA** : dans une salle des Fonctions avancées, « Inviter
  l'IA » ajoute WorkPilot IA, qui répond à chaque message avec le fournisseur et le modèle choisis
  pour la page (tous les providers). Elle lit la conversation et le fichier de la salle, choisi
  dans le projet ouvert ; un bloc de code qu'elle propose s'affiche comme suggestion sur ce
  fichier, sans rien écrire. La salle dit qu'elle reste sur cet ordinateur. Corrigés au passage :
  le départ d'une salle prévient enfin le backend, la liste des participants suit les arrivées,
  et un message part sous le bon nom quand d'autres sont arrivés avant.
- **`@ia` dans le chat d'équipe** (projets du serveur) : un message qui mentionne `@ia` reçoit une
  réponse de l'IA, en réponse à ce message et marquée 🤖, calculée par l'app de son auteur avec
  le fournisseur de sa page Insights. Toute l'équipe la voit ; une mention d'un coéquipier ne
  coûte rien aux autres.
- **Mot de passe oublié sur le serveur d'équipe.** **Mot de passe oublié ?** sur l'écran de
  connexion, dans l'app de bureau et sur le téléphone : la personne reçoit un lien par e-mail
  quand le serveur a SMTP, sinon un administrateur de la plateforme l'émet depuis
  **Administration → Membres** et le transmet. Le lien sert une fois, pendant 60 minutes par
  défaut (`WORKPILOT_PASSWORD_RESET_TTL_MINUTES`), et le nouveau mot de passe ferme toutes les
  sessions du compte. Guide : [`docs/server-guide.md`](docs/server-guide.md#un-mot-de-passe-oublié).
- **Pixel Office : succès et mode TV** (#350) : le bureau gagne des succès à partir de ce que le
  projet livre (première livraison, dix tâches en sept jours, QA passée à la première revue,
  incident Self-Healing résolu ou réparé par un agent, accord d'un second moteur), sur tous les
  providers, annoncés une seule fois dans le bureau et listés sous le trophée de la barre
  d'outils. Le **mode TV** affiche le bureau en plein écran pour l'écran d'une équipe, avec de
  grands compteurs, une horloge, une relecture chaque minute et un **mode calme** qui arrête
  toutes les animations, actif d'office quand le système demande moins d'animations.
- **Pixel Office : saisons, scènes et couleurs des fournisseurs** (#350) : chaque trimestre est
  une saison avec cinq objectifs d'équipe (livrer, passer la QA du premier coup, refactoriser,
  résoudre des incidents, obtenir l'accord d'un second moteur) ; un objectif atteint décore le
  bureau pour de bon. Quand une tâche change de mains, le bureau raconte la scène (« Coder vient
  de rendre sa copie pour la spec n°042 au Reviewer QA »), écrite par un modèle de la page si on
  l'active, sans jamais lui envoyer le titre ni le contenu de la tâche. Chaque personnage porte la
  couleur du fournisseur qui le fait tourner.
- **Pixel Office : classement d'équipe, badges et cosmétiques** (#350) : sur un projet du
  serveur, le bureau affiche le classement de l'équipe, pour le projet ou toute l'organisation,
  cette saison ou depuis le début, calculé par le serveur de l'équipe et jamais envoyé ailleurs.
  Une tâche livrée vaut 1 à 3 points selon la complexité évaluée de sa spec, relire la tâche d'un
  collègue en vaut 2, et aucun jeton ni prix n'est compté. Personne n'y apparaît par son nom sans
  l'avoir accepté ; chacun voit toujours son propre score et ses badges. Le bureau laisse aussi
  choisir l'habit des personnages (couleurs du fournisseur, les leurs, ou le néon, gagné quand
  chaque objectif de saison a été atteint une fois) et cacher une pièce du décor gagné.
- **Les serveurs MCP du projet atteignent aussi Codex, OpenCode, Gemini CLI et Copilot**. Un
  serveur installé depuis le catalogue ou ajouté dans Outils des agents n'était démarré que pour
  Claude et les modèles de la boucle WorkPilot. Les CLI le reçoivent maintenant dans leur propre
  format, à la même condition que Claude : seulement si chaque outil qu'il liste est celui que
  vous avez approuvé, et sans aucun secret sur une ligne de commande. Copilot passe par le même
  pont qu'OpenAI.
- **REA au catalogue MCP**, en option et pour les tâches d'enquête seulement : la version figée de
  WorkPilot, cinq outils au démarrage, et aucun outil qui pilote un appareil, un navigateur ou un
  programme en marche.
- **API publique .NET gardée pendant une migration**. Après la QA d'une tâche .NET, chaque
  bibliothèque qu'elle touche est construite avant et après la tâche, dans des copies jetables, et
  REA compare les deux assemblies : un membre public retiré, rendu interne, renommé ou dont la
  signature change est signalé. Par défaut la porte prévient sans bloquer, et seulement si REA est
  installé ; pendant une migration .NET préparée par WorkPilot, ou quand le workflow déclare la
  porte dure `public-api-stable`, la rupture renvoie la tâche au fixer. Un build qui échoue ou un
  membre que REA n'a pas pu apparier n'est jamais compté comme réussi.
- **Porte « Exposition de l'artefact »**. Après la QA, REA lit sans la lancer la sortie de build
  que la tâche a laissée (bundle Electron ou Tauri, APK, build web et ses source maps, dossier
  `publish` .NET, jar, wheel, exécutable Rust…) et signale ce qu'elle expose. Par défaut elle
  prévient sans bloquer ; en `strict`, ou quand le workflow déclare la porte dure
  `artifact-exposure`, un check exposé au seuil (`high` par défaut) renvoie la tâche au fixer.
  Ce que REA n'a pas pu trancher ne bloque jamais, et une vérification qui n'a pas pu tourner
  n'est jamais comptée comme réussie. Le Release Train gagne la même étape, `exposure`, avant le
  déploiement de chaque service.
- **REA dans « Outils CLI »**. Le panneau dit si REA (`rea-agents`, l'outil qui lit ce que révèle
  un build livré sans le lancer) est installé à la version que WorkPilot exécute, et l'installe
  en un clic, cette version et aucune autre. Le backend gagne le module qui lance REA : seulement
  ses lectures statiques, sans shell, sans vos identifiants, et jamais de téléchargement par npx
  dans un projet en mode hors-ligne strict.
- **Partager un rejeu d'agent** (#347) : une session enregistrée s'exporte en fichier
  `.wpreplay`, qu'un collègue importe dans son WorkPilot (et compare à une des siennes), ou en
  une page HTML autonome que chacun ouvre sans rien installer. Les secrets et les dossiers
  locaux sont toujours masqués ; le raisonnement, les tokens et coûts, et le contenu des
  fichiers ne partent que si on le veut. Des signets annotés marquent les étapes d'une session
  terminée et partent avec elle.
- **Un rejeu d'agent se partage avec l'équipe par un lien** (#347) : en mode serveur, un
  membre du projet confie la session, déjà masquée, au projet et reçoit un lien qui dure de 1 à
  30 jours ; un collègue du projet le colle dans « Ouvrir un lien d'équipe » et la session
  s'importe. L'auteur ou le propriétaire du projet révoque le lien, et l'app montre combien de
  fois il a été ouvert. Le serveur ne garde que l'empreinte du jeton.
- **Les signets d'un rejeu se discutent** (#347) : chaque lecteur répond à la note d'un signet ;
  les réponses partent masquées avec l'export et s'affichent sous le signet dans la page.
- **Vidéo côte à côte et MP4** (#347) : la vue de comparaison exporte la vidéo des deux sessions
  jouées en même temps, et chaque vidéo s'exporte aussi en MP4 quand la machine a `ffmpeg`
  (l'app dit sinon ce qui manque).
- **Les chiffres d'usage des rejeux, calculés sur place** (#347) : la vue Agent Replay montre les
  exports de chaque semaine (fichier, page, vidéo, lien d'équipe) et la part des sessions qui
  portent un signet, comptés sur la machine ; pour un projet du serveur, elle ajoute ce que
  l'équipe fait de ses liens sur quatre semaines (liens créés, part ouverte, ouvertures, part
  annotée), calculé par ce serveur, en totaux seulement. Aucune télémétrie : rien n'est envoyé
  ailleurs.
- **Révoquer ses liens d'équipe depuis les Réglages** (#347) : en mode serveur, « Liens de
  rejeu » liste chaque lien qu'une personne a créé, sur tous les projets du serveur dont elle est
  encore membre, avec son état, son échéance, ses ouvertures et « Révoquer ».
- **Un rejeu d'agent s'exporte en vidéo** (#347) : la page HTML du rejeu, déjà masquée, est
  jouée étape par étape dans un navigateur sans fenêtre et enregistrée en WebM (deux minutes au
  plus), hors réseau. Sans Chromium ou sans Playwright, l'app dit ce qui manque et comment
  l'installer.
- **Résumé des étapes par un modèle** (#347) : une session dont le modèle n'a laissé aucun
  raisonnement se résume à la demande, en quelques lignes, par le modèle rapide du provider par
  défaut, quel qu'il soit. Le modèle lit la session masquée, citée comme une donnée ; le
  résumé, masqué lui aussi, part avec l'export, la page et la vidéo.
- **Retours sur la revue de PR : revues de suivi, taux d'acceptation, conventions** (#361, lot 2) :
  les types de remarque que le projet a rejetés sont aussi rétrogradés ou retirés des revues de
  suivi, et leur verdict est recalculé avec la règle de la revue initiale sur les résultats qui
  restent (jamais plus sévère que celui du relecteur). Sous les résultats d'une revue, la vue
  « Retours sur les revues de ce projet » donne, par catégorie, les acceptés, rejetés et non
  applicables, les types de remarque masqués ou rétrogradés, et un bouton pour en réinitialiser
  un. Un bouton écrit `.workpilot/review-conventions.md`, les règles déduites des retours, sans
  modèle : les mêmes retours donnent toujours le même fichier.
- **Retours sur la revue de PR : projets serveur, rejets en attente, relecture avant publication**
  (#361, lot 3) : sur un projet serveur, Accepter / Rejeter / Non applicable, le taux
  d'acceptation et la réinitialisation d'une règle marchent comme sur un projet local ; le serveur
  écrit les retours dans le clone, où la revue apprend. Le rejet d'un membre attend qu'un
  propriétaire du projet l'approuve ou l'écarte avant que le relecteur n'en tienne compte ; seul
  un propriétaire réinitialise une règle. Avant le verdict, la revue fond en un seul résultat, au
  niveau le plus grave, une remarque faite plusieurs fois au même endroit, et le dit dans son
  résumé. Une revue de suivi sans nouveau commit applique aussi les retours donnés depuis.
- **Retours sur la revue de PR : remarques contraires, mainteneurs prévenus, conventions d'un
  projet serveur** (#361, lot 4) : avant de publier, la revue demande au modèle du provider choisi
  si deux remarques proches d'un même fichier demandent des changements opposés, et retire la plus
  faible des deux, jamais une remarque de sécurité ni critique ; son résumé le dit. Sur un projet
  serveur, quand le rejet d'un membre commence l'attente, les mainteneurs du projet en sont
  prévenus sur leurs canaux « Besoin de toi » (ntfy, Telegram, Teams), un moment qu'on coupe dans
  ses préférences ; le message ne donne que le projet et le numéro de la PR. Le fichier
  `review-conventions.md` d'un projet serveur se construit depuis les retours du serveur et
  s'enregistre où l'on veut, dans sa copie de travail. Le panneau donne aussi, par mois, les PR
  revues, les résultats par PR et les règles apprises, calculés sur la machine ou sur le serveur
  de l'équipe.
- **La revue de PR par l'IA apprend des faux positifs** (#361) : chaque résultat d'une revue
  peut être accepté, rejeté ou marqué non applicable, avec une raison facultative (trop
  pointilleux, convention du projet, faux positif, exception de code hérité, autre). Les avis
  sont gardés dans `.workpilot/code_review_feedback.jsonl`. Un type de remarque rejeté trois fois
  de plus qu'accepté est rétrogradé en mineur, et retiré de la revue à six ; la revue dit
  combien de résultats elle a masqués et lesquels. La règle s'applique après la revue, donc avec
  tous les providers ; les résultats de sécurité et critiques ne sont jamais touchés.
- **Une microVM Docker par tâche, en option.** Dans Paramètres > Sandbox, « Lancer chaque tâche
  dans une microVM Docker » (coupé par défaut) fait tourner les commandes de la boucle WorkPilot
  (OpenAI, Google, Mistral, Copilot, modèles locaux…) dans une microVM Docker Sandboxes (`sbx`)
  propre à la carte : seuls le worktree, la spec et le dépôt git y sont montés (hooks et
  configuration git en lecture seule, `.workpilot/.env` masqué), le réseau est fermé hors des
  registres de paquets, et la mémoire et les processeurs sont bornés. Sous Windows 11, c'est le
  premier bac à sable des commandes. Sans `sbx` prêt, le bac à sable de l'OS prend le relais et
  la carte dit pourquoi. La télémétrie de `sbx` est coupée.
- **Un CLI d'agent dans la microVM de la tâche (expérimental).** Avec la microVM allumée, un second
  interrupteur de Paramètres > Sandbox lance OpenCode dans la VM de la tâche, avec les clés que vous
  avez rangées dans sbx (`sbx secret set openai`…). WorkPilot ne copie aucune clé : dans la VM, le
  CLI ne voit qu'un substitut, et le proxy de sbx ajoute la vraie clé. Sans clé rangée, le CLI
  reste sur l'hôte et la carte dit pourquoi. Coupé par défaut.
- **État de Docker Sandboxes dans les paramètres.** Quand la microVM par tâche est activée,
  Paramètres > Sandbox indique si `sbx` est installé et connecté, avec sa version et le nombre de
  microVM de WorkPilot, et un bouton Vérifier. Supprimer le worktree d'une tâche supprime aussi
  sa microVM, et `sbx` est trouvé là où winget l'installe sous Windows.
- **Les failles de la QA classées par ce qui tourne vraiment** (#364). Le rapport de sécurité de
  la QA range désormais ses trouvailles en quatre sections : critiques et exposées, critiques mais
  dormantes, moyennes, informatives. Le classement vient de ce que les points d'entrée du projet
  atteignent (routes, handlers, `main`, commandes, dans tout langage) et des incidents de
  production des 30 derniers jours déposés dans `.workpilot/incidents/` (Sentry, Datadog,
  CloudWatch, New Relic…), avec le nombre d'utilisateurs touchés quand l'outil le donne. Une
  dépendance que le projet ne déclare pas est marquée transitive, un code chargé par son nom
  rend l'atteignabilité incertaine, et un secret écrit dans le dépôt n'est jamais rétrogradé. Le
  fixer reçoit les failles exposées en premier ; ce qui bloque un build suit toujours la gravité.
- **L'auto-guérison corrige ses incidents par une carte du Kanban** : un échec de CI, une erreur de production ou un fichier fragile devient une carte du backlog (`Fix: …`, origine « Self-Healing »), avec l'analyse de l'incident. Son build planifie, code et passe la QA dans un worktree, puis attend votre revue avant sa PR. L'incident suit la colonne de sa carte (en correction, en QA, PR ouverte, résolu, échec), avec le lien de la PR.
  - La correction automatique de production suit enfin son propre réglage (désactivé par défaut) au lieu de celui de la CI/CD.
  - Le réglage « Créer automatiquement les PR » est retiré : la PR suit la revue de la carte.
  - Le taux de correction automatique compte les incidents dont la carte a atteint sa PR, et le temps moyen de résolution va du signalement à la résolution.
- **Auto-guérison proactive : tendances de risque** (#370). Chaque scan garde un instantané par
  fichier (`.workpilot/self-healing/health_history.sqlite`, un par jour, 120 jours) ; chaque
  fichier reçoit une trajectoire (stable, montée lente, montée rapide, amélioration), avec sa
  courbe, ce qui l'explique (complexité, churn) et un drapeau quand il entre dans la liste
  chaude. Les dossiers dont la plupart des fichiers montent ensemble sont signalés.
- **Production : un incident par bug** (#372). Une empreinte (type d'erreur normalisé, fichier
  et fonction du frame le plus interne du dépôt, service, version ; sans numéros de ligne ni
  identifiants) regroupe les rapports de Sentry, Datadog, PagerDuty… en un seul incident et une
  seule tentative de correction. Les commits suspects depuis la dernière release sont classés,
  et les incidents d'un même commit en héritent la priorité la plus haute.
- **CI/CD : bisect assisté** (#375). Quand le dernier commit n'est probablement pas le coupable
  (diff minuscule, test ancien, dépendance modifiée), les tests en échec sont rejoués entre le
  dernier commit vert et le commit en échec dans un worktree temporaire, borné en exécutions et
  en temps, sans toucher la copie de travail ; le premier commit fautif et son diff vont au
  correcteur. Bouton « Bisect » sur chaque incident CI/CD, réglage `autoBisect`.
- **Chaque membre d'un serveur d'équipe a ses comptes IA** (mode serveur). Plusieurs clés par
  fournisseur (OpenAI, Google, Mistral, DeepSeek, Grok, Meta, OpenRouter, Hugging Face, et un jeton
  Claude Code), une par défaut : les runs et les jobs que la personne lance l'utilisent à la place
  de la clé du serveur, et un fournisseur sans compte garde celle du serveur. Les clés sont
  chiffrées sur le serveur, jamais réaffichées, et chaque route a sa permission
  (`settings.account.read`, `settings.account.write`).
- **Mode serveur, approbation des specs** (#363) : un plan qui attend ses approbations plus longtemps que l'équipe ne le permet prévient un second groupe d'approbateurs sur ses canaux « Besoin de toi » (`WORKPILOT_APPROVAL_ESCALATION_HOURS`, par criticité, et `WORKPILOT_APPROVAL_ESCALATION_ROLES`, `owner` et `admin` par défaut), une fois par run de spec, et l'entrée va au journal. L'app de bureau (Spec Approval) et l'app mobile (la carte, et la page « Approbations prêtées » du tableau) règlent la criticité d'une carte, montrent ses approbations et les rôles qui manquent, et prêtent son approbation à un collègue ou la reprennent. Le téléphone ne lance plus le build après une approbation partielle : il dit combien d'approbations la carte a.
- **Mode serveur, connexion** (#363) : l'app mobile se connecte par le fournisseur OpenID Connect du serveur (« Se connecter par authentification unique ») ; Entra et lui y partagent le même flux, avec un `nonce` vérifié avant d'envoyer l'`id_token`. Chaque connexion a un identifiant que portent ses jetons : le journal de l'organisation dit qui s'est connecté, comment et d'où, et chaque action nomme la connexion sous laquelle elle a été faite (`GET /admin/audit?login_id=`). Une personne désactivée, ou retirée de l'organisation ou d'un projet, voit ses délégations d'approbation se terminer.
- **La page de santé, les métriques Prometheus et les traces du serveur** (mode serveur).
  `GET /admin/platform/health`, pour les administrateurs de la plateforme, dit pourquoi le
  serveur va bien ou non : base et révision du schéma, espace disque des clones et de la base, file des runs et des jobs, version, isolation des runs (Landlock) et tâches
  périodiques. `GET /metrics` sert les mêmes chiffres et des comptes par organisation au format
  Prometheus, à un collecteur qui envoie `WORKPILOT_METRICS_TOKEN` (404 sans lui). Avec
  `AUTO_CLAUDE_OTEL_ENDPOINT`, chaque requête devient un span OpenTelemetry nommé d'après sa
  route. Aucun ne nomme une personne, un projet ni un chemin.
- **Héberger le serveur multi-utilisateur là où l'équipe le peut** : `deploy/configure.py`
  demande où tourne le serveur (un VPS ou un serveur avec un nom DNS public en HTTPS, une
  machine du réseau local, ou cet ordinateur pour un essai) et écrit `.env.server` (secrets
  générés une seule fois, gardés quand on change de choix), le `Caddyfile` et le proxy qui
  rendent l'API et le flux en direct joignables. Le guide d'exploitation décrit les trois cas,
  un PC Windows sous Docker Desktop compris.
- **Mode serveur : connexion par n'importe quel fournisseur OpenID Connect** (Okta, Google,
  Keycloak, Auth0…), à côté de Microsoft Entra. L'opérateur donne l'émetteur et l'identifiant du
  client (`WORKPILOT_OIDC_ISSUER`, `WORKPILOT_OIDC_CLIENT_ID`) ; l'écran de connexion de l'app
  propose « Se connecter avec {nom} ». Une adresse ne relie un compte existant que si le
  fournisseur l'a vérifiée.
- **Mode serveur : une spec est approuvée par une autre personne que l'auteur de la carte** quand
  quelqu'un d'autre sur le projet peut approuver. `WORKPILOT_SELF_APPROVAL` règle ce choix
  (`when-alone` par défaut, `deny`, ou `allow`, qui garde le comportement d'avant).
- **Mode serveur : une carte critique est approuvée par plusieurs personnes.** Une carte est
  `low`, `medium` ou `high` ; l'opérateur dit combien d'approbations il faut à chaque niveau
  (`WORKPILOT_APPROVAL_QUORUM`) et quels rôles doit tenir l'un des approbateurs
  (`WORKPILOT_APPROVAL_ROLES`). Un approbateur règle la criticité d'une carte ; l'évaluation de la
  spec peut seulement la relever. Modifier la spec ou le plan annule les approbations données ; le
  build ne démarre qu'une fois la carte approuvée, et l'app dit où en sont les approbations.
- **Mode serveur : un approbateur prête son approbation sur un projet** à un collègue, pour 90
  jours au plus (absence, astreinte) : le collègue approuve au nom de l'approbateur, sans pouvoir la
  prêter à son tour. Approbations, criticités et délégations entrent au journal d'audit de
  l'organisation.
- **Le serveur compte les tokens de chaque run** : chaque session d'agent d'un run ou d'un job
  du serveur (tous providers) envoie au serveur ses tokens, son provider, son modèle et son coût,
  rangés avec la personne qui l'a lancé, son projet et son organisation. Le budget mensuel de
  tokens des quotas compte enfin cette consommation (il restait à 0 et ne bloquait rien), la Vue
  d'ensemble et l'onglet Quotas l'affichent, et un run note son provider.
- **Menu de gauche redimensionnable à la souris** : son bord droit montre une poignée au survol ;
  glissez-le pour élargir ou rétrécir le menu (de 240 à 480 px), jusque sur le rail pour le
  replier, double-cliquez pour revenir à la largeur par défaut. La largeur est retenue. Au
  clavier, la poignée se prend avec Tab : flèches pour redimensionner, Entrée pour replier.
- **Smart Estimation apprend chaque dépôt** (#367) : à chaque fusion, l'estimation d'une spec est
  comparée à ce qu'elle a réellement consommé (coût, tokens, itérations de QA, fichiers modifiés),
  quel que soit le provider. Les estimations suivantes en tirent un facteur par dépôt et par
  catégorie (correction de bug, infrastructure, frontend, backend, fonctionnalité), affiché en
  fourchette avec sa confiance, un détail par dimension (algorithmique, intégration, risque de
  conflit, tests), des alertes quand le dépôt s'écarte du générique, la comparaison des providers
  et la précision des estimations passées. « Ajuster l'estimation » garde votre propre score,
  « Réinitialiser la calibration » repart des chiffres génériques après une refonte. Aucune durée
  n'est estimée.
- **Les cartes vertes restent vertes sur la vraie base.** Après chaque fusion, les autres cartes
  approuvées reprennent la nouvelle base dans leur worktree et relancent leur suite : sur la CI de
  la forge quand elle est suivie, sinon par une nouvelle revue QA sur la machine. Un conflit est
  annulé et noté, et un worktree avec des changements non commités n'est pas touché.
- **Un test cassé se voit sans attendre toute la suite.** La revue QA lance d'abord les tests des
  fichiers changés et de ce qui les importe, avec l'outil de chaque pile ; s'ils échouent, elle
  rejette tout de suite et la correction démarre, sans passer par les longues suites.
- **La suite complète d'une tâche ne fait plus ramer la machine.** Avant une revue QA complète,
  WorkPilot mesure ce que la machine a de libre (CPU, RAM, GPU, VRAM, autres tâches en cours)
  contre ce que la suite du projet a pris les dernières fois, et la lance ici s'il y a la place.
  Sinon elle attend son tour dans une file commune à la machine, une suite après l'autre, sans
  jamais être sautée. Le choix est écrit pour la carte ; l'envoi vers la CI de la forge viendra
  avec l'app.
- **La suite complète d'une tâche peut tourner sur la CI de la forge, sans PR.** Quand le build l'y
  envoie, l'app pousse la branche de la tâche, juge la suite sur tous les runs de ce commit
  (GitHub Actions, Azure Pipelines, GitLab CI, Bitbucket Pipelines, Jenkins), lance elle-même les
  pipelines qui valident les PR si le push n'en a déclenché aucun, et une suite rouge suit le
  chemin « Build rouge » jusqu'à sa réparation.
- **Chaque carte peut garder son propre choix pour ses longues suites.** Le choix fait sur la
  carte (automatique, cette machine ou la CI) passe avant celui du projet quand la revue QA
  décide où lancer la suite complète.
- **Choisir où tournent les longues suites de tests.** Dans les réglages du projet, un
  interrupteur Automatique / Manuel : en automatique, WorkPilot choisit entre cette machine, la CI
  de la forge et le serveur selon la place libre ; en manuel, vous choisissez cette machine ou la
  CI. Chaque carte peut garder son propre choix. La carte montre où sa suite tourne et le verdict
  de la CI, et la fusion attend que la suite lancée sur la CI soit verte.
- **Des budgets de tokens par personne, groupe et projet** (mode serveur). En plus du budget
  mensuel de l'organisation, chaque administrateur fixe un budget mensuel à une personne, un
  groupe ou un projet (`/admin/usage/budgets`), compté depuis le 1er du mois ; un budget
  bloquant épuisé refuse les nouveaux runs et jobs de ce qu'il couvre. Chaque budget, celui de
  l'organisation compris, alerte une fois par mois à 80 % et à 100 %, par e-mail aux
  destinataires du rapport d'usage, et le rapport quotidien liste les budgets au-delà d'un
  seuil. Chaque changement est audité, et l'effacement d'un compte retire son budget.
- **Le rapport d'usage quotidien par e-mail** (mode serveur). Chaque organisation reçoit à 9 h
  (heure de Paris par défaut, `WORKPILOT_REPORT_TIMEZONE`) le rapport de la veille : tokens et
  coût, part du budget mensuel, personnes actives, nouvelles et sans activité, runs, réussites,
  échecs, tâches fusionnées et coût par tâche livrée, chacun face à la veille et à la moyenne des
  7 jours ; les 5 plus gros consommateurs, la répartition par fournisseur et modèle, les causes
  des échecs et l'alerte de budget à 80 % et 100 %. Heure, fuseau, jours, destinataires (une
  adresse hors de l'organisation est signalée), langue, noms ou non, rapports hebdomadaire et
  mensuel se règlent par organisation (`/admin/usage/report/settings`), chaque changement audité.
  Un rapport ne part qu'une fois, même après un redémarrage, et un serveur arrêté à l'heure
  l'envoie à son retour ; sans SMTP, il se lit dans l'app (`GET /admin/usage/report`). Aucun
  prompt, code ni texte saisi n'y figure, et l'effacement d'un compte retire son adresse des
  destinataires.
- **Les chiffres d'usage du serveur d'équipe, calculés par le serveur.** Les routes
  `/admin/usage/*` (permission `usage.read`) donnent, sur une période et avec des filtres par
  personne, groupe, projet, provider et modèle : les chiffres clés (tokens, coût, part du budget,
  personnes actives, taux de succès), la consommation par jour et par provider, le détail par
  personne avec sa chronologie, les providers et modèles par phase, les projets, les pages
  ouvertes, l'entonnoir d'adoption, le coût par tâche livrée et le délai jusqu'au merge, les
  échecs groupés par cause, qui est connecté et les comptes dormants. Chaque table s'exporte en
  CSV (export audité) ; `/admin/platform/usage/*` donne les mêmes vues pour toute la plateforme.
  Registre RGPD mis à jour : [`docs/server-usage-data.md`](docs/server-usage-data.md).
- **Activité par page sur le serveur d'équipe, désactivée par défaut.** Un administrateur de
  l'organisation l'active dans le nouvel onglet **Administration → Usage** (permission
  `usage.write`), une fois les membres informés : l'app de bureau et le téléphone comptent alors
  combien de fois chacun ouvre chaque page, par jour, sous un nom d'une liste fermée (ni projet,
  ni carte, ni texte). La désactiver efface les comptes ; chaque changement est audité. Chaque
  organisation règle aussi combien de temps elle garde la consommation et la présence (365 jours
  par défaut) et l'activité par page (183 jours). Registre RGPD :
  [`docs/server-usage-data.md`](docs/server-usage-data.md).
- **Nom du forfait dans la répartition de l'utilisation** : le compte actif et les autres comptes affichent leur forfait, tel que le fournisseur l'indique : Claude Pro, Max 5x ou Max 20x (lu dans la connexion de Claude Code), ChatGPT Plus ou Pro (Codex CLI), Copilot Free, Pro, Pro+, Business ou Enterprise, Windsurf, Cursor. Un compte facturé par une clé API (Anthropic, OpenAI, Mistral, Google, DeepSeek, Grok…) l'indique : « Clé API · à l'usage ». Un fournisseur qui ne nomme pas son forfait (Gemini CLI connecté par Google) affiche seulement « Abonnement » ; rien n'est deviné. Toutes les sources sont locales ou déjà lues pour l'usage : aucun appel réseau de plus.
- **Connexions et présence sur le serveur d'équipe.** Une connexion refusée entre dans l'historique
  d'audit de l'organisation (`auth.login_failed`), avec sa méthode et sa raison (mot de passe
  faux, compte désactivé, compte inconnu, jeton du fournisseur refusé), jamais le mot de passe ni
  l'adresse tapée pour un compte inconnu ; chaque job lancé y entre aussi. Le serveur note le jour
  où chacun l'utilise, base des personnes actives par jour, semaine et mois et des comptes
  dormants de la future vue Usage. Consommation et présence s'effacent après
  `WORKPILOT_USAGE_RETENTION_DAYS` (365 jours par défaut). Ce qui est gardé, pour le registre
  RGPD : [`docs/server-usage-data.md`](docs/server-usage-data.md).
- **Le rapport d'usage et les budgets se règlent dans l'app de bureau** (mode serveur).
  **Administration → Usage → Rapport** règle l'heure, le fuseau, les jours, la langue, les noms,
  les rapports hebdomadaire et mensuel et jusqu'à 20 destinataires (une adresse hors de
  l'organisation est signalée, et l'écran dit à qui il part quand aucune n'est choisie) ; il montre
  les derniers envois, l'aperçu du rapport d'un jour, d'une semaine ou d'un mois tel que l'e-mail
  le porte, et l'envoie tout de suite. **Usage → Budgets** liste le budget de l'organisation et
  chaque budget par personne, groupe ou projet avec sa consommation du mois, en ajoute, modifie ou
  supprime un, et montre les dernières alertes à 80 % et 100 %.
- **Mon usage, l'information des membres et l'effacement d'un compte sur le serveur d'équipe.**
  Chacun lit ce que les administrateurs voient de lui et quels rôles le lisent
  (`GET /users/me/usage`), et exporte en JSON tout ce que le serveur garde de son usage
  (`/users/me/usage/export`). Un message dit à chaque membre ce qui est mesuré ; sa lecture est
  inscrite à l'audit, et il revient quand l'activité par page est activée. Un administrateur de la
  plateforme efface un compte (`POST /admin/users/{id}/erase`) : la consommation, la présence et
  l'audit restent sans nom, adresse et IP sont effacées.
- **L'onglet Usage du bureau montre les chiffres du serveur d'équipe.** Sur une période et des
  filtres (personne, groupe, projet, provider, modèle) : tokens, coût, part du budget, personnes
  actives, tokens par jour, tables par personne, modèle, phase et projet, entonnoir d'adoption,
  causes d'échec, présence et pages ouvertes ; chaque table s'exporte en CSV. Un nom ouvre la
  fiche de la personne ; un compte dormant se désactive ; un administrateur de la plateforme voit
  toute la plateforme et efface un compte. **Paramètres → Mon usage** montre à chacun ce que les
  administrateurs voient de lui, exporte tout en JSON et relit le message de ce qui est mesuré,
  affiché une fois à chaque membre.
- **L'assistant vocal écoute en continu, et « stop » arrête les agents proprement** (#385) :
  depuis son panneau, « Écoute continue » garde le micro ouvert entre les commandes, avec un
  voyant qui pulse, la phrase affichée pendant sa transcription et un bouton pour couper le micro.
  La parole est séparée du bruit de la pièce par une détection calibrée au démarrage, dont la
  sensibilité se règle dans Paramètres → Assistant vocal. Dire « stop » (ou « arrête tout »)
  demande confirmation, puis chaque tâche en cours termine l'appel d'outil en cours et s'arrête
  avant le suivant, quel que soit le fournisseur ; elle reprend depuis sa carte.
- **L'assistant vocal répond à voix haute, se réveille sur « Hey WorkPilot » et guide une tâche en
  cours** (#385) : le retour vocal (Paramètres → Assistant vocal : muet, court ou bavard) lit les
  réponses avec les voix du système, sur l'ordinateur, et en mode bavard ce que font les tâches.
  Le mot d'éveil, optionnel et personnalisable, ouvre l'assistant quand l'écoute continue est
  éteinte, avec un voyant et un bouton pour couper le micro. En écoute continue, le mode binôme
  suit une tâche, dit ce qu'elle fait et envoie à son agent ce que vous dites, après un « oui ».
  Avec « Détecter automatiquement », la langue entendue par Whisper sert à lire la phrase. Une
  touche F13 à F24 seule (une pédale) peut servir de raccourci, et la dictée du formulaire de tâche
  prend le micro de l'écoute continue sans qu'il faille le couper.
- **WinDev dans la traduction inter-langages et le studio de tests** : WLangage peut être traduit
  vers les autres langages (un élément WinDev est réduit à son code, sans les propriétés de
  l'éditeur), jamais vers WLangage. Le studio de tests dit qu'un projet WinDev s'écrit ses tests
  dans l'éditeur au lieu de produire un fichier pytest.
- **WLangage dans la vue des diffs** : les éléments WinDev au format texte sont colorés (mots-clés
  en français ou en anglais, chaînes, commentaires, types) et les propriétés que seul l'éditeur
  écrit (`internal_properties`, `identifier`) sont atténuées, pour lire le code et pas le base64.
- **WinDev dans le Kanban** : une porte de la QA compare chaque fichier WinDev changé à sa version
  d'avant la tâche et renvoie au fixer tout ce que seul l'éditeur sait écrire (binaire modifié,
  contrôle ou élément inventé, `procedure_id` en double, fichier qui ne se lit plus). La couverture
  n'est plus exigée d'un changement purement WinDev, et l'encart « Plateformes mobiles » reconnaît
  un projet WinDev Mobile sans proposer d'installer un autre framework.
- **Les projets WinDev, WebDev et WinDev Mobile sont reconnus**. Un projet sauvegardé au format
  texte (option Git, version 25 et plus) reçoit les skills `wlangage` et `windev-text-format`, et
  chaque agent du Kanban sait qu'il ne modifie que le code WLangage, jamais les propriétés que seul
  l'éditeur produit ni les fichiers binaires ; ce que seul l'éditeur sait faire devient une étape
  « À faire dans l'éditeur WinDev ». Un projet au format natif, illisible hors de l'éditeur, est
  signalé au lieu d'être deviné. La compilation et les tests restent à lancer dans WinDev.

### 🐛 Corrections

- **Fonctions avancées entièrement en français** : domaines, gravités, catégories de licence,
  types de violation, signaux de longévité, actions de santé des agents, niveaux de routage,
  types d'événements d'audit et d'opérations de pair programming s'affichent dans la langue de
  l'app au lieu de l'anglais du backend. La dérive d'architecture liste enfin les violations
  (fichier, ligne, import visé), dit d'où viennent ses règles et prévient quand aucune
  référence n'est enregistrée.
- **Santé des agents lue dans les vraies tâches du projet** : le panneau notait un moniteur en
  mémoire que rien n'alimentait, et affichait toujours « aucune exécution ». Il lit maintenant le
  `task_logs.json` de chaque tâche Kanban du projet (la copie du worktree quand la tâche tourne,
  sans compter deux fois), et note chaque agent (planificateur, codeur, QA) par provider et
  modèle : taux de succès, erreurs, relances de phase, durée, tendance. Les couples qui n'ont pas
  encore trois phases terminées sont listés à part. Le bouton « Réinitialiser l'historique », qui
  vidait ce moniteur vide, est retiré.
- **API Explorer** : l'application vérifie elle-même chaque requête que la page lui demande
  d'envoyer (adresse `http` ou `https`, méthode connue, en-têtes et corps bornés) et la portée
  et les champs des secrets qu'elle range, comme le font déjà ses autres vues.
- **Émulateur d'application** : un démarrage lance la configuration que l'app a détectée pour le projet, et non celle que l'écran lui renvoie ; l'installation des dépendances tourne dans le même environnement que le serveur de développement.
- **Journal d'audit** : un événement dont le contenu porte une valeur que JSON ne sait pas écrire
  (`NaN`, infini, par exemple un score de risque) est refusé avant d'être chaîné. Il était inscrit
  tel quel, puis la réponse au panneau et les exports SOC2 et RGPD de ce journal échouaient.
- **Azure DevOps** : les appels au connecteur (test de connexion, dépôts, work items, détection du dépôt) passent par un runner du backend, `runners/azure_devops/connector_call.py`, qui reçoit le dossier du projet, l'opération et ses paramètres en arguments : un projet dont le nom de dossier contient une apostrophe fonctionne, et la détection du dépôt ne reçoit plus d'identifiant. Les quatre canaux de revue de PR Azure DevOps, qu'aucun écran n'appelait, sont supprimés.
- **Revue IA des pull requests Azure DevOps** : la revue aboutit enfin. Elle échouait à chaque
  lancement et l'échec était enregistré comme une approbation ; une revue qui n'a pas pu tourner
  est désormais marquée en échec avec sa cause. L'app lit le résultat au lieu d'afficher
  « Failed to parse review result », le diff montre les lignes réellement modifiées au lieu d'un
  simple résumé par fichier, le contexte du projet est transmis au relecteur, et un verdict
  « bloqué » n'est plus adouci par des constats moins graves.
- **Jeton Claude sous Linux** : le backend ne lisait jamais le Secret Service (il l'appelait sans connexion DBus, ce qui échouait à chaque fois) et ne lisait pas `~/.claude/.credentials.json`, où Claude Code range son jeton sous Linux. Sans `CLAUDE_CODE_OAUTH_TOKEN`, la CLI disait donc « aucun jeton » à une personne connectée. Les deux sont lus, dans cet ordre ; un profil ne lit toujours que sa propre entrée.
- **Source du jeton affichée par la CLI** : avec un profil sans identifiants, elle nommait le trousseau par défaut alors que le build ne s'en sert pas ; elle suit maintenant l'ordre de lecture du jeton.
- **Couverture backend, lot B2d** : `core/auth.py` passe à 100 % (variables d'environnement, fichier d'un profil, trousseau macOS, fichiers Windows, Secret Service, ce qui est donné au SDK, Git Bash sous Windows). Retirés, faute d'appelant ou parce qu'ils ne pouvaient pas aboutir : le déchiffrement des jetons `enc:` (il échouait toujours ; un tel jeton reste refusé avec la marche à suivre), le lancement du login (`trigger_login`, `ensure_authenticated`) et un avertissement de jeton différent qui ne pouvait jamais se déclencher.
- **Nom d'entrée d'un profil sous Windows** : un dossier de profil écrit avec `~` ou avec des `/` donnait un autre nom d'entrée que celui de l'app (le backend ne remplaçait pas les `/` par des `\` comme `credential-utils.ts`).
- **Le backend ne reste plus bloqué sur un trousseau Linux verrouillé.** En cherchant le jeton
  Claude, il demandait de déverrouiller le trousseau et attendait la réponse sans limite : sous WSL
  la fenêtre s'affichait vide et `/health` ne répondait plus. Un trousseau verrouillé est maintenant
  passé, et le jeton est lu dans `~/.claude/.credentials.json`.
- **`pnpm run dev` ne casse plus sur « Address already in use »** : quand un backend WorkPilot
  tourne déjà sur le port 9000 (lancement précédent resté ouvert, ou celui que l'app a démarré
  pendant l'installation des dépendances), il est réutilisé avec un message clair au lieu de faire
  échouer la commande. Un port pris par un autre programme est nommé, avec la commande qui le
  montre sur Windows, macOS, Linux et WSL. Côté app, un backend qui perd le port au profit d'un
  autre backend ne déclenche plus la boîte d'erreur, et la sortie du backend lancé par l'app est
  lue en continu pour qu'il ne se bloque plus sur ses propres logs.
- **Le tri des issues GitHub lit enfin la réponse du modèle** : la réponse était toujours lue vide, et chaque issue repartait classée « fonctionnalité » à 50 % de confiance, quoi que le modèle ait dit.
- **Le détail d'une PR GitHub (`/api/github/pr-details`) répond** : la route échouait à chaque appel. Elle accepte une URL `https://github.com/<propriétaire>/<dépôt>/pull/<numéro>` et refuse toute autre forme avant d'appeler `gh`.
- **Le provider GitHub sait fusionner et fermer une PR, créer et fermer une issue, créer et lister des labels, et poster sur l'API** : ces opérations appelaient une méthode absente et échouaient toujours.
- **Deux exécutions ne tiennent plus le même verrou d'état en même temps** : en le relâchant, le fichier de verrou était supprimé pendant qu'une autre exécution l'attendait, et une troisième pouvait verrouiller un nouveau fichier à côté. Le fichier reste désormais en place (il n'est supprimé que sous Windows, qui refuse de supprimer un fichier encore ouvert ailleurs).
- **Une relance d'auto-fix refusée ou en échec ne remplace plus le résultat précédent** : l'issue garde l'état terminé ou échoué de sa dernière exécution.
- **La limite de débit GitHub s'applique aussi aux fonctions non asynchrones**, qui levaient une erreur au lieu de s'exécuter.
- **Le nettoyage des PR suivies compte chaque PR une fois**, même quand elle est à la fois expirée et bloquée « en cours ».
- **Couverture backend, lot GitHub (cœur du runner)** : le provider GitHub, la route de détail de PR, les modèles, le validateur de lots, le tri, l'auto-fix, les prompts, les worktrees de revue, les permissions, la détection de bots, le runner, le verrou de fichiers et la limite de débit passent à 100 % (lignes et branches), sur de vrais dépôts git et un `gh` simulé.
- **Les workflows GitHub visent toujours le dépôt configuré** : les commentaires, labels et
  lectures d'issues, ainsi que les appels à l'API (fichiers et commits d'une PR, commentaires
  depuis la dernière revue, comparaison de commits, approbation des workflows de fork), ne
  dépendent plus du dépôt que le dossier local désigne. Une lecture de l'API avec des paramètres
  reste une lecture au lieu de partir en écriture, et l'assignation d'une PR à plusieurs personnes
  envoie bien la liste des comptes.
- **La revue de PR GitHub en plusieurs passes rapporte enfin ce que le modèle a trouvé** :
  quand l'orchestrateur parallèle est désactivé, chaque passe (balayage rapide, sécurité,
  qualité, structure, tri des commentaires d'autres outils d'IA, analyse approfondie) lisait la
  réponse du modèle sous une forme que le client ne produit plus, et la revue se terminait
  toujours sans aucun constat.
- **La revue de suivi d'une PR GitHub garde la réponse structurée du modèle** même quand le SDK
  ne la donne que dans son message de fin : elle ne retombait plus alors sur la lecture
  heuristique du diff.
- **Lots d'issues GitHub enregistrés pour de bon** : les lots créés par le regroupement, ceux
  validés dans l'assistant et ceux qui passent en analyse sont maintenant écrits sur le disque
  (ils restaient en mémoire), et l'état des lots s'affiche au lieu d'échouer dès qu'un lot existe.
- **Revue de PR GitHub** : les réponses aux commentaires des outils d'IA sont publiées quand la
  publication automatique est activée (elles échouaient toutes), le suivi d'une revue interroge
  le dépôt configuré, et une revue ou un suivi terminé ne laisse plus la PR « en cours de revue »
  pendant trente minutes. La ligne de synthèse ne dit plus « tous les checks passent » quand la
  CI tourne encore, et un constat dont le titre parle de CI ou de conflit de merge reste compté
  comme un problème de code.
- **Messages de Git du cerveau partagé** : la ligne d'erreur de Git affichée après une
  synchronisation retire désormais en entier la partie identifiant d'une adresse de dépôt,
  même quand elle contient elle-même un « @ ».
- **Cerveau partagé sur un dossier en lecture seule** : quand le `.gitignore` du vault ne peut
  être ni lu ni écrit, les fichiers propres à la machine (corbeille, conflits, caches) sont
  exclus par le fichier d'exclusion local du dépôt, et une synchronisation ne les envoie plus.
- **Garde-fou des worktrees sur Windows** : un worktree à la racine d'un disque désigne la
  racine du disque (`D:\`) comme dossier interdit, et non le dossier courant de ce disque.
- **Prompts sur Windows** : le chemin de la spec donné à l'agent s'écrit avec des `/`
  (`./.workpilot/specs/001-x/spec.md`), au lieu de mêler `\` et `/`.
- **Vault de mémoire** : un lien symbolique du vault qui mène hors de lui n'est plus suivi,
  ni en lecture ni en écriture ; un lien qui reste dans le vault fonctionne comme avant.
- **Détecteur d'anomalies CI/CD sur toutes les stacks, sans faux positifs** : il reconnaît
  maintenant les échecs de NuGet/.NET (NU1605, NU1101, NU1301, test host planté), Maven, Gradle,
  Cargo, Composer, pub (Flutter), Go, pip, Bundler, SwiftPM, Docker Hub et des runners GitHub
  Actions, et non plus npm et la JVM seuls. « Changed », « Exchange » ou « tests 401 à 420 »
  ne déclenchent plus de délai dépassé ni d'échec d'authentification. Chaque correctif a un
  identifiant et s'affiche dans la langue de l'app ; on peut coller plusieurs builds pour voir
  les échecs qui reviennent, et les correctifs suggérés s'affichent enfin.
- **CI/CD Triggers et Self-Healing vérifient ce qu'ils reçoivent** : le déclenchement d'un
  pipeline suit le mode hors-ligne strict du projet et ne suit plus de redirection ; les valeurs
  envoyées par la page (fournisseur, branche, workflow, ids, réglages, source de production) sont
  contrôlées avant de lancer le runner, et la configuration d'une source de production lui
  parvient sur son entrée standard.
- **Le forfait Claude affiché suit le compte.** Un compte passé de Pro à Max restait affiché
  « Pro » : WorkPilot montrait le forfait noté à la connexion. Il demande maintenant à Anthropic le
  forfait actuel (Claude Max 20x…) et corrige le profil. Les détails de l'authentification montrent
  le même forfait que la répartition de l'utilisation, pour tous les fournisseurs (ChatGPT,
  Copilot…), et n'affichent plus « Aucun profil configuré » pour un compte connecté par abonnement.
- **Pourcentages d'usage de Claude rétablis avec plusieurs comptes.** La popin d'utilisation lit
  le compte Claude actif, celui des tâches, et non plus le compte le moins utilisé (un compte tout
  juste ajouté passait devant). Quand la connexion de ce compte a expiré, elle propose de le
  reconnecter au lieu d'annoncer que le fournisseur ne publie pas de quota.
- **La page Code Migration montre le plan qu'elle a fait** : ses phases, ses étapes et son
  risque s'affichent après l'analyse, et la tâche Kanban créée depuis la page les reçoit dans
  sa description. La cible se lit au dernier nom de pile de la phrase (« de React vers Vue »
  vise Vue), et une pile dont le framework reste est planifiée par ses langages (une app React
  passée de JavaScript à TypeScript, un service Java converti en Kotlin) : bien plus de
  migrations reçoivent un plan connu au lieu d'un plan libre.
- **Contexte cognitif lié au projet** : l'optimiseur lit les fichiers du projet ouvert (choisis
  dans le projet, tapés relativement à lui, ou proposés par WorkPilot quand la liste est vide) et
  liste ceux qu'il n'a pas lus avec la raison. Les extraits gardent les déclarations de toutes
  les stacks (C#, Java, Kotlin, Go, Rust, PHP, Swift, Dart…), se déplient dans le panneau et se
  copient. Avec `WORKPILOT_COGNITIVE_CONTEXT_ENABLED`, le coder reçoit enfin ce contexte packé :
  l'option n'avait jusqu'ici aucun effet. Le budget est borné à 200 000 tokens comme le backend.
- **Garde de la configuration de sécurité** : les noms de fichiers d'une commande shell sont lus
  comme le shell les lit.
- **Prédicteur de conflits** : chaque branche est comparée à la branche dont elle part
  (`DEFAULT_BRANCH`, sinon `main`, `master` ou `develop`) et seulement pour ce qu'elle a changé
  depuis. Un dépôt sur `master` ne donnait plus aucun résultat, et ce que la base avait changé
  après le départ des branches apparaissait comme un conflit entre elles. L'alias
  `origin/HEAD` n'est plus pris pour une branche, et un fichier déjà en conflit n'est plus
  répété parmi les zones à risque.
- **Azure DevOps** : les fichiers modifiés d'une pull request ont de nouveau leur chemin (il
  arrivait vide), et leur ancien chemin quand ils sont renommés.
- **Contexte d'une tâche** : un projet rangé sous un dossier nommé `build`, `dist` ou `out` n'est
  plus ignoré en entier ; les imports relatifs JavaScript (`./`, `../`) et `from paquet import
  module` en Python relient enfin les fichiers ; la recherche de code lit aussi C#, Java, Kotlin,
  Go, Rust, PHP, Ruby, Swift… et nomme les fichiers `src/a.cs` sur tous les systèmes.
- **Clonage d'environnement** : une image d'un registre avec port (`registry:5000/api`), les ports
  en syntaxe longue ou `127.0.0.1:8000:80`, un `docker-compose.yml` vide et la sortie JSON en
  tableau des versions récentes de Compose ne font plus échouer la capture ; sans PyYAML, les
  services sont lus quelle que soit l'indentation, sans prendre les réseaux ni les volumes.
- **Performance Profiler** : une requête, une boucle imbriquée ou une lecture bloquante n'est
  signalée que si elle est dans le bloc de la boucle ou de la fonction, et non quelques lignes plus
  bas (fini les N+1 sur un `dict.get`) ; les règles lisent aussi C#, Java, Kotlin, Go, Rust, C/C++,
  Swift, PHP ; le temps des tests est mesuré pour Go, Cargo, .NET, Maven, Gradle et Mocha, avec
  `python3` quand `python` n'existe pas ; le conseil `useCallback` est de nouveau proposé.
- **Context Mesh** : les recommandations d'un projet sont retrouvées (le modèle nomme les projets,
  la recherche se faisait par chemin) ; la pile vient du détecteur commun à toute l'app ; un projet
  se retire avec le chemin tapé ; un enregistrement illisible ne masque plus tous les autres et
  chaque fichier s'écrit de façon atomique.
- **Cycles d'imports du contexte** : un cycle est nommé à partir du même fichier sur toutes les machines ; le premier fichier dépendait de l'ordre dans lequel le disque listait les fichiers.
- **Streaming, enregistrements** : une session enregistrée garde enfin ses événements. L'enregistreur était démarré, mais aucun événement n'y entrait, et chaque fichier sous `~/.workpilot/recordings` ne contenait que l'en-tête. Les événements émis quand le serveur est injoignable sont gardés aussi, et un identifiant de session devient un nom de fichier valable sous Windows.
- **Streaming, rejeu** : chaque événement attend l'écart qui le séparait du précédent. Il attendait l'écart depuis le premier, si bien qu'une session de dix minutes durait bien plus au rejeu. Une vitesse nulle ou négative est refusée.
- **Streaming, origine refusée** : une page d'une autre origine reçoit un vrai `403`. Le serveur répondait par une réponse invalide, que le client lisait comme une panne.
- **Mission Control** : mettre en pause un agent qui ne tourne pas, ou reprendre un agent qui n'est pas en pause, n'écrit plus d'événement dans le journal. Le chemin de décision d'un agent inconnu répond `404`, et une limite nulle ou négative rend un journal vide.
- **Barre d'état (ccstatusline)** : le script lancé par son chemin retrouve le paquet `ui`. Il échouait à l'import.
- **Interface en terminal** : Ctrl+C interrompt un menu, une touche spéciale n'y choisit plus d'option, une barre de progression au-delà de 100 % reste de la bonne largeur, une ligne colorée tronquée dans un cadre referme sa couleur et garde le cadre droit, et un fichier d'état illisible ne fait plus planter la barre d'état.
- **Message de commit proposé après un merge** : sans réponse du modèle, il reprend le nom de la
  spec au lieu d'un titre vide, et une réponse entourée d'un bloc de code n'en garde que le texte.
- **Revue d'architecture** : un rapport d'une ronde QA précédente n'est plus relu comme le
  nouveau, et une violation de gravité inconnue reste listée comme avertissement.
- **Aperçu du Kanban** : un projet sans script de lancement habituel n'essaie plus de lancer un
  script de build ou de déploiement.
- **Index du projet** : un service Python d'un monorepo (`pyproject.toml` sans `package.json`)
  déclenche bien le rafraîchissement de l'index, comme les fichiers de dépendances Java, Gradle,
  Dart, Swift et Elixir.
- **Prompts du planner et de la QA** : le planner ne cherche plus le projet à côté d'un dossier
  `auto-claude/`, un plan à la forme inattendue ne casse plus la reprise d'un build, et les
  outils de validation du projet sont injectés même si le prompt de QA a été retouché.
- **Carte d'architecture** : les imports relatifs Python (`from ..models import X`) et JS/TS
  (`../lib/api`, `./ui` vers `ui/index.tsx`) relient enfin les bons modules, et un projet rangé
  sous un dossier `build/` ou `out/` est lu.
- **Documentation des bibliothèques (.NET)** : les projets `.csproj`, `.fsproj`, `.vbproj`,
  `Directory.Packages.props` et `packages.config` sont lus, et l'usage d'une bibliothèque compte
  aussi dans le code F# et VB ; un `pom.xml` ne retient que ses blocs `<dependency>`.
- **Documentation des bibliothèques** : la page téléchargée et la section du prompt disent au
  codeur que la documentation est une référence, pas une consigne ; un fichier de résultat
  abîmé (taille illisible, erreurs écrites comme une chaîne) se relit sans erreur, comme une
  liste de fichiers de plan d'une autre forme.
- **Analyse des licences** : une réponse de registre d'une autre forme (liste au lieu d'objet,
  licence unique écrite comme une chaîne, corps binaire) donne « licence inconnue » au lieu d'une
  erreur ou d'une licence épelée lettre par lettre ; un `package.json`, `pyproject.toml`,
  `Cargo.toml` ou `composer.*` d'une autre forme n'interrompt plus l'analyse.
- **Applications mobiles (Android)** : un SDK Android installé à l'emplacement par défaut
  d'Android Studio est trouvé sans `ANDROID_HOME` ; les dossiers par défaut de chaque système
  n'étaient jamais consultés.
- **Applications mobiles** : un `package.json` d'une autre forme (liste, dépendances écrites
  comme une liste) ne fait plus manquer la détection d'une application Capacitor voisine, et une
  liste de simulateurs iOS d'une autre forme donne « aucun simulateur » au lieu d'une erreur.
- **Bac à sable de l'OS** : un port au-delà de 65535 passé à la porte loopback est refusé
  proprement (code 126) au lieu d'une trace d'erreur.
- **Pièces jointes (OCR)** : une réponse d'une autre forme du modèle de vision local (liste des
  modèles, réponse) ou du service Azure se lit comme « pas de réponse » au lieu d'interrompre la
  lecture de la pièce jointe.
- **Pièces jointes** : un `requirements.json` d'une autre forme (liste, images jointes écrites
  comme un texte) ne fait plus échouer la liste des pièces jointes d'une tâche.
- **Schémas Excalidraw** : une scène dont les liaisons de flèches ou la liste d'éléments ont une
  autre forme se lit sans erreur ; seules les flèches reliées des deux côtés sont tracées.
- **Tableau blanc → draw.io** : deux boîtes que le modèle de vision donne sous le même identifiant
  ne produisent plus un fichier `.drawio` aux cellules en double (la première l'emporte), et des
  listes d'une autre forme dans sa réponse se lisent comme « rien de dessiné ».
- **Maquettes Figma** : une réponse de l'API dont les enfants d'un calque ne sont pas une liste
  n'interrompt plus l'import, et un `.figma.json` écrit à la main dont les libellés sont un texte
  au lieu d'une liste ne se lit plus lettre par lettre.
- **Captures HTTP → tests** : une collection Postman ou un fichier OpenAPI retouchés à la main
  (une liste remplacée par un texte ou un nombre) ne font plus échouer la lecture ; une ligne
  `curl` ne prend plus la valeur d'une option (`-o fichier`, `-u`, `-b`, `-A`…) pour l'URL, et
  `-u` / `-b` se lisent comme les en-têtes `Authorization` / `Cookie` qu'ils deviennent, donc
  masqués.
- **Conformité d'architecture** : un `workspaces` vide ou enraciné dans un `package.json` ne fait plus échouer la lecture du graphe de modules.
- **Exigences tirées des pièces jointes** : un `drafts.json` retouché à la main (une proposition
  sans tous ses champs, un identifiant accepté d'une autre forme) n'empêche plus la carte de
  charger ni la décision d'aboutir ; l'entrée incomplète est ignorée.
- **QA visuelle** : un `visual_qa.json` retouché à la main (une liste remplacée par un nombre
  ou un texte, une lecture qui n'en est pas une) ne fait plus échouer chaque revue suivante ni
  le rapport ; ce qui ne se lit pas est ignoré.
- **Carte d'architecture** : un projet rangé sous un dossier nommé `build`, `dist` ou `.venv`
  n'est plus lu comme vide ; seuls les dossiers de ce nom *dans* le projet sont écartés.
- **Carte d'architecture** : un `package.json`, un `pyproject.toml` ou un `requirements.txt` d'une
  autre forme (dépendances en liste, texte qui n'est pas de l'UTF-8) se lit comme « sans
  dépendance » au lieu d'interrompre la collecte.
- **Carte d'architecture** : un composant qui cite un fichier d'un dossier caché (`.github/`,
  `.tools/`) garde sa source à l'épinglage et compte quand ce fichier change ; un changement sous
  `.workpilot/` ou `.venv/` n'est plus pris pour un changement d'architecture.
- **Carte d'architecture** : un modèle dont `meta` ou `components` n'a pas la forme attendue va
  jusqu'à la validation d'archify, qui dit quoi corriger, au lieu d'arrêter la génération ; un
  modèle illisible (dossier, texte qui n'est pas de l'UTF-8) est signalé comme tel.
- **Onglet Delta** : un `delta.status.json` retouché à la main, dont un champ a une autre forme,
  s'affiche sans erreur.
- **Cerveau partagé** : l'échec d'un clone n'est plus classé « authentification » parce que le
  chemin ou l'URL qu'il cite contient `403` ou `permission denied`.
- **Mémoire partagée** : l'avis d'un modèle sur deux notes en conflit est lu même quand le modèle
  ajoute des accolades après sa réponse, et une entrée de la file d'une autre forme est refusée
  proprement.
- **Mémoire partagée** : une file de conflits retouchée à la main (un côté qui n'est pas un objet)
  ne fait plus échouer son affichage ni sa résolution, et une note dont `agents` ou `tasks` est
  écrit comme un seul texte n'est plus lue lettre par lettre.
- **Journal de la mémoire** : une ligne fusionnée d'un autre poste dont `related` est un texte ne
  le lit plus lettre par lettre, et plusieurs lignes sans identifiant ne se réduisent plus à la
  première.
- **Corbeille de la mémoire** : une note oubliée dont le bloc `lifecycle` a été retouché à la main
  s'affiche et se restaure au lieu de faire échouer l'onglet, et des `variants` écrits comme un
  seul texte restent un nom de note.
- **Cerveau partagé** : une note dont `agents`, `tasks`, `sources` ou `tags` est écrit comme une
  seule valeur dans Obsidian (`agents: coder`) n'est plus réenregistrée lettre par lettre quand un
  agent la complète.
- **Cerveau partagé sur un dossier en lecture seule** : quand le fichier `.gitignore` du
  vault ne peut pas être écrit, le cerveau s'ouvre et se synchronise quand même, au lieu
  d'échouer avant chaque synchronisation.
- **Serveur MCP du cerveau** : une recherche ou une requête du graphe dont l'agent laisse la
  limite vide (`null`) ou d'une autre forme répond avec la limite par défaut, au lieu d'une
  erreur interne du serveur.
- **Mémoire des builds** : quand le modèle écrit une liste de pièges ou de conventions sous
  forme d'un seul texte, ce texte devient une note, au lieu d'une note par lettre ; des
  découvertes de session ou un ancien fichier de session d'une autre forme ne font plus
  échouer l'enregistrement ni l'import de l'ancienne mémoire.
- **Graphe du cerveau** : un `graph.json` laissé par un autre outil avec des nœuds ou des liens
  vides (`null`) ou d'une autre forme se lit comme un graphe vide, au lieu de faire échouer
  chaque recherche jusqu'à la reconstruction suivante.
- **Connexion du cerveau aux agents** : un fichier de configuration d'agent illisible ou
  impossible à écrire est signalé pour cet agent seulement, et les autres agents sont quand
  même connectés ; une CLI Claude Code qui ne répond pas ou ne démarre pas laisse WorkPilot
  écrire sa configuration directement, au lieu de faire échouer la connexion.
- **La ligne CI/CD reste sous la PR d'une tâche** : après « Create Pull Request » depuis la revue,
  la fiche de la tâche perdait le pipeline que CI/CD Triggers venait de lancer (et la preuve
  visuelle) jusqu'au rechargement du tableau. Elle les garde désormais.
- **Serveurs MCP personnalisés** : les en-têtes et variables d'environnement d'un serveur suivent
  désormais la même règle que les autres identifiants du projet. L'écran Outils des agents les
  affiche masqués, une modification du serveur garde la valeur enregistrée, et la vérification
  ou le test de connexion utilise cette valeur, pour le même serveur à la même adresse.
- **Fichier glissé sur un terminal de la grille** : son chemin est cité comme lorsqu'il est déposé
  sur le terminal lui-même, en un seul mot quel que soit son nom.
- **Le tableau de bord et la page Coûts montrent enfin les tâches faites.** Une tâche Kanban écrivait ses tokens, son coût, ses verdicts QA et sa durée dans le `.workpilot` de son worktree, que ces vues ne lisaient pas et que la fusion supprime : un projet aux tâches terminées affichait 0 tâche, 0 token, 0 €. Toutes les sessions écrivent désormais à la racine du projet (verrou entre processus pour les tâches parallèles), les relevés des worktrees encore présents sont repris, les tâches sont comptées depuis le Kanban, la phase de spec compte ses tokens, le temps moyen par complexité se remplit, et un provider qui ne donne pas de prix est chiffré au catalogue. Local et mode serveur.
- **Design-to-code** : une analyse ou une liste de fichiers qu'un modèle rend sous une autre forme
  que celle demandée (un objet seul, une liste, un nombre) ne fait plus échouer tout le pipeline :
  l'analyse garde la réponse brute, le code arrive comme sortie brute. Le commentaire posté sur
  Figma nomme les composants de chaque pile (Flutter, SwiftUI, Compose, Angular, Blazor, XAML…),
  et plus seulement ceux de React, Vue et Svelte.
- **`pnpm dev` starts the backend again when `apps/backend` has no virtualenv of its own.** The
  launcher passed uvicorn an absolute `--reload-exclude` for `apps/backend/.venv` even when that
  folder did not exist (venv at the repo root), and uvicorn stopped with « Non-relative patterns
  are unsupported ». The exclude is now passed only when the folder is there, in `pnpm dev` and in
  the backend the app starts in development.
- **Porte d'API publique .NET et mutation sous Windows** : la copie de travail d'une tâche reçoit
  enfin ses changements non commités. Le correctif passait par un tube texte, qui changeait les
  fins de ligne (CRLF vers LF à la lecture, LF vers CRLF à l'écriture sous Windows), et `git apply`
  le refusait : la porte ne construisait jamais la version de la tâche.
- **CI de develop au vert sous Windows et macOS** : les tests lancent chaque runner Python avec
  l'UTF-8 de l'app, une taille de fichier ne dépend plus des fins de ligne de Windows, et le test
  des journaux de tâche laisse Radix finir avant la fin du fichier.
- **Documents du dépôt dans le prompt** : les titres et décisions des ADR et les libellés d'un
  diagramme d'architecture sont lus comme une pièce jointe (vérifiés, sur une ligne) avant
  d'être cités ; une modification d'exigence que le masquage ne sait pas lire n'est pas
  enregistrée, la proposition reste.
- **Carte d'architecture** : la description de la tâche est citée comme une donnée, et les noms
  de fichiers et de dépendances du dépôt restent sur leur ligne dans le prompt.
- **Mémoire partagée** : l'avis demandé à un modèle sur deux notes cite aussi comme une donnée ce
  que le détecteur a relevé dans ces notes.
- **Agents spécialisés par domaine appliqués au projet** : le domaine choisi s'enregistre dans
  `.workpilot/domain.json` du projet (« Appliquer à ce projet »), et chaque tâche Kanban en reçoit
  les garde-fous à la planification, au code et à la QA, y compris dans son worktree. Avant, le
  panneau ne faisait qu'un aperçu : seul un `domain` écrit à la main dans `requirements.json`
  atteignait les agents. Les bibliothèques conseillées suivent les stacks détectées du projet
  (.NET, Java/Kotlin, Go, Rust, PHP, Ruby, Dart, Swift, Python, JS/TS…), et non plus Python et
  npm seuls.
- **Une carte fusionnée en local passe en Done** : après « Merge to main », la déplacer dans Done tentait d'ouvrir une PR, échouait (« aucun commit à pousser ») et la laissait en revue. Une branche déjà contenue dans la branche de base, sans travail non commité dans son worktree, ne déclenche plus de PR.
- **L'app ne relance plus `pip install` à chaque démarrage** : la vérification de l'environnement Python attendait un module que rien n'installe (`google.generativeai`) et concluait toujours à une dépendance manquante.
- **Titre de tâche modifiable : un enregistrement refusé rend vraiment le focus** : le champ était encore désactivé quand on y remettait le focus, si bien qu'il restait sans focus. Pire, le blur que le navigateur envoie au champ désactivé pouvait relancer en silence l'enregistrement du même titre. Le champ est désormais réactivé avant de recevoir le focus. Cela corrige aussi le test `EditableTaskTitle` qui échouait au hasard sur develop.
- **Mode serveur** : les routes des vagues d'exécution sont de nouveau montées, et l'API démarre.
- **Fusion, aperçu de fusion, analyse d'impact et création de PR répondent par une erreur lisible quand le backend ne peut pas démarrer** : si le lancement de Python échouait d'emblée, l'appel IPC était rejeté et la fenêtre recevait une exception brute au lieu du message « échec » attendu.
- **La détection des IDE et terminaux écarte de nouveau un chemin qui remonte d'un dossier après expansion** (`%USERNAME%`, `~`) : le contrôle normalisait le chemin avant de chercher `..`, qui disparaissait donc toujours sous Windows et après un préfixe absolu.
- **Refuser une tâche ne jette plus le travail en cours du projet principal** : quand la revue humaine renvoyait une tâche, l'app remettait à zéro tout le projet (`reset`, `checkout -- .`, `clean -fd`) dès qu'un worktree existait, et des modifications de la personne sans rapport avec la tâche partaient avec. Seule une fusion préparée par la tâche (« stage only ») est maintenant annulée, fichier par fichier.
- **Une tâche bloquée avant d'avoir écrit son plan peut être récupérée** : la récupération répondait « plan corrompu » ; elle repart d'un plan vide, vers le backlog ou vers la création de la spec si on la relance.
- **La création d'une PR depuis le statut ne laisse plus son script temporaire dans le projet** quand Python échoue, et un titre de tâche en HTML ne donne plus un titre de PR sur plusieurs lignes.
- **Un `$` dans le titre ou la description d'une tâche ne corrompt plus `spec.md`** (duplication et modification) : il était lu comme un motif de remplacement.
- **Reprendre la session d'une tâche refuse une session d'un autre provider** au lieu de la passer au SDK Claude.
- **Les arguments reçus du renderer sont revérifiés** pour le retour de revue, le modèle et l'effort d'une reprise, et le changement à chaud.
- **Les handlers de l'auto-fix GitHub revérifient ce que le renderer envoie avant de l'utiliser** : numéro d'issue (ou liste de numéros), nombre maximal d'issues d'une analyse, forme de la configuration et des lots approuvés. Un appel refusé n'atteint pas le handler (`autofix-ipc-guard.ts`, sur le même garde que les pull requests, `ipc-arg-guard.ts`).
- **La configuration de l'auto-fix (`.workpilot/github/config.json`) ne garde plus de jeton** : comme le runner, l'app n'y écrit que des réglages, et retire un jeton qu'elle y trouve.
- **Approuver des lots d'auto-fix lance le runner comme les autres commandes de l'auto-fix** : avec l'environnement du runner (fournisseur choisi, jeton GitHub), sans bloquer l'app pendant l'exécution ; le dossier `.workpilot/github` est créé s'il manque, et le fichier des lots approuvés est supprimé même quand le runner échoue.
- **L'aperçu des lots dit qu'aucun résultat n'est revenu** quand le runner ne renvoie rien, au lieu du message sur un résultat illisible.
- **Le lanceur des runners GitHub et GitLab lit des lignes entières** : une ligne de progression ou un message d'expiration de connexion coupé entre deux morceaux de sortie était lu en deux et manqué ; la dernière ligne sans retour à la ligne est lue aussi.
- **La vérification de `gh` ne passe plus par un shell** : `gh` est cherché sur la machine (y compris les dossiers d'installation hors `PATH`), puis `gh auth status` est lancé avec une liste d'arguments.
- **Le nombre d'issues ouvertes de la connexion GitHub est le vrai** : il comptait la première page d'une liste demandée par pages de un, donc 0 ou 1, et les pull requests avec ; il vient maintenant du total de la recherche GitHub.
- **L'analyse d'une issue GitHub lit un dépôt configuré en URL** (`https://github.com/owner/repo`) : elle seule ne normalisait pas la référence, et l'appel partait vers une adresse invalide.
- **Les handlers GitHub des issues, de l'analyse et du test de connexion revérifient ce que le renderer envoie** : numéro d'issue, état, page et configuration du test, et une référence de dépôt qui n'est pas un seul `owner/repo` ne devient plus une adresse d'API.
- **Le journal d'une revue de PR n'est lu et écrit que pour un vrai numéro de PR** : le numéro reçu du renderer nomme le fichier, il doit maintenant être un entier positif.
- **La version proposée pour une release ne vaut plus jamais `NaN`** : une version de `package.json` comme `2.1` ou `1.4.2-beta.1` donne `2.1.1` ou `1.4.3`, une version absente ou qui n'est pas du texte compte comme `0.0.0`, et le type de montée (majeure, mineure, corrective) se lit dans les versions plutôt que dans les mots de la raison.
- **Un commit dont le sujet ou l'auteur contient `|` arrive entier à la suggestion de version** : les champs de `git log` sont séparés par un caractère qui n'apparaît pas dans un sujet.
- **Un projet GitHub dont le dossier porte `..` dans son nom (`my..app`) n'est plus refusé** : le contrôle cherchait `..` dans un chemin absolu déjà normalisé, où il ne reste jamais de remontée.
- **Les handlers des pull requests GitHub revérifient ce que le renderer envoie avant de l'utiliser** : numéro de PR (ou liste de numéros), identifiant d'exécution de workflow, méthode de fusion (`merge`, `squash` ou `rebase`), login GitHub de l'assigné, texte d'un commentaire et curseur de page. Un appel refusé n'atteint pas le handler (`pr-ipc-guard.ts`).
- **Revue de PR GitHub plus fiable** : une revue qui échoue arrête le spinner de sa PR au lieu de
  le laisser tourner ; annuler une revue arrête aussi les processus qu'elle a lancés, et la
  relance d'une revue n'est plus effacée par la fin de la précédente. Un check GitHub expiré
  compte comme un échec de CI, un dépôt configuré par son URL de clone fonctionne, un gros diff
  n'est plus coupé et deux commentaires publiés en même temps ne se mélangent plus. Les appels à
  `gh` ne bloquent plus la fenêtre, et les arguments de publication et de la mémoire des revues
  sont vérifiés dans le main. `pr-handlers.ts` passe de 2 153 à environ 800 lignes
  (`pr-review-run.ts`, `pr-freshness.ts`, `pr-review-memory.ts`), couverts à 100 %.
- **Issues et merge requests GitLab** : l'investigation d'une issue écrit enfin dans la tâche les commentaires choisis (section « Selected comments », 50 au plus, chacun borné), lus par pages de 100 et non plus sur la première page de 20. Les handlers des issues, des notes, des merge requests, de l'import et de l'investigation revérifient ce que le renderer envoie avant de l'utiliser : état de la liste en liste fermée, iid, liste d'issues, champs d'une nouvelle merge request (`gitlab/ipc-guard.ts`). Le code GitLab que l'UI n'appelait pas est supprimé : auto-fix, triage, création de release, lecture d'un projet, d'une issue ou d'une merge request seule, et modification d'une merge request, avec leurs canaux et méthodes du preload.
- **Revue IA d'une merge request GitLab** : une même MR n'est revue qu'une fois à la fois. Annuler arrête aussi les processus lancés par le runner, et les tue s'ils sont encore là une seconde plus tard. Une revue annulée ne retire plus l'entrée d'une revue relancée après elle. Le nombre de nouveaux commits depuis la revue se compte sur les 100 derniers commits, et non plus sur la première page de 20. Un `GITLAB_REBASE_TIMEOUT_MS` invalide retombe sur 60 s. Les handlers revérifient ce que le renderer envoie avant de l'utiliser : iid de MR, méthode de fusion, identifiants d'assignés, texte de note et findings à publier (`mr-ipc-guard.ts`). Le canal `GITLAB_MR_GET_DIFF`, que l'UI n'appelait pas, est supprimé.
- **Connexion GitLab par `glab` sur une instance auto-hébergée** : la page des réglages envoie
  le nom d'hôte de l'instance, que le main lisait comme une URL invalide avant de retomber sur
  gitlab.com. La vérification de la connexion, la connexion, l'utilisateur et la liste des
  projets visent maintenant l'instance configurée (port compris). Le jeton de `glab` s'affiche
  comme défini, comme les autres jetons du projet, et c'est le main qui l'enregistre quand on
  valide la connexion. `glab` est lancé par son chemin, sans shell, et la page de connexion
  s'ouvre par `openExternalUrl`, sur l'hôte de l'instance seulement. Un projet GitLab réglé par
  son URL de clone fonctionne, et un en-tête `X-Total` illisible compte zéro. Cinq canaux IPC
  que l'interface n'appelait jamais (détection du projet, branches, création de projet, ajout
  du remote, groupes) et deux fonctions inutilisées sont retirés ; la connexion et les
  utilitaires GitLab sont couverts à 100 %.
- **Import Azure DevOps** : un Bug importé depuis la fenêtre d'import reçoit la catégorie « correction de bug » (`bug_fix`) que filtre le tableau, au lieu d'une catégorie `bug` qui n'existe pas ; les autres types (User Story, Feature, Task, types personnalisés) deviennent des features, et non plus une catégorie `task` inconnue.
- **Tâches importées d'Azure DevOps** : la réparation de l'affichage n'écrit que les champs qu'elle a changés, sans effacer un titre écrit entre-temps, et un `requirements.json` qui n'est pas un objet est signalé comme illisible. La synchronisation des critères d'acceptation ne lit que le work item dont la tâche est issue. Les handlers Azure DevOps revérifient ce que le renderer envoie (`azure-devops-ipc-guard.ts`) : ids de work item entiers positifs, liste bornée, types courts, option d'import limitée à son champ ; la construction d'une tâche importée vit dans `azure-devops-import.ts`.
- **Terminaux et profils Claude** : les handlers des terminaux, de leurs sessions, des profils Claude, de la bascule automatique et de l'usage revérifient ce que le renderer envoie avant de l'utiliser (`terminal/terminal-ipc-guard.ts`) : identifiants et noms bornés, tailles entières, jour au format `AAAA-MM-JJ`, réglages de bascule limités à leurs champs. Un nouveau terminal ne reçoit du renderer qu'une variable d'environnement, le dossier `CLAUDE_CONFIG_DIR` d'un profil sous le dossier personnel. Relancer après une limite de débit ne change plus de profil pour un projet inconnu et signale un profil introuvable. Les canaux que l'UI n'appelait pas sont supprimés : effacer les sessions d'un projet, reprendre Claude dans un terminal par son canal, demander l'usage par `/usage` et lire le meilleur profil disponible. Le test des dossiers reçus par l'IPC lit aussi les handlers enregistrés sur un `ipcMain` gardé.
- **Worktrees de terminal** : « Autres worktrees » ne liste plus le projet lui-même ni les worktrees de WorkPilot quand le projet est ouvert par un lien symbolique (ou sous `/var` sur macOS) : les chemins sont comparés une fois les liens résolus. Les handlers des worktrees de terminal passent par la même vérification des arguments que les terminaux, une config de worktree illisible ou qui n'est pas un objet est ignorée, et le lien vers `node_modules` qui ne peut pas être créé ne fait plus échouer la création quand c'est son dossier parent qui manque.
- **Le détective de tests instables lance vraiment les tests .NET, et ceux de toutes les stacks** (F204). Sur une solution qui ne liste aucun projet de test, `dotnet test` compilait sans rien lancer et le détective accusait une erreur de compilation : il vise désormais les projets de test (la solution qui les contient, sinon les projets eux-mêmes), gère Microsoft.Testing.Platform de .NET 10 (xunit.v3, MSTest) et dit clairement « aucun projet de test » ou « aucun test lancé », avec la fin de la sortie et le chemin du journal complet. Jest sans plugin, `node --test`, Rust, PHPUnit/Pest, RSpec, Dart/Flutter et Swift sont pris en charge ; la porte de mutation ne lance plus `dotnet test` sur une solution sans tests.
- **Forges** : chaque projet lit ses issues, PR et merge requests dans le dépôt de ses propres
  remotes git. Sans dépôt enregistré, GitHub et GitLab prennent celui du remote du projet ; un
  dépôt enregistré qui n'est aucun remote du projet (copié d'un autre projet) est signalé dans
  les réglages GitHub, GitLab et Azure DevOps, avec le bon dépôt en un clic. La revue de PR et
  l'autofix GitHub utilisent le jeton et le dépôt du projet au lieu du compte global de `gh`.
  Les remotes `gitlab.com` sont reconnus à l'ajout d'un projet.
- **Vérification des labels GitHub sous Windows** : la lecture paginée des événements d'une
  issue passe ses paramètres à `gh` comme champs, et non dans l'URL. Les tests des revues
  GitHub, GitLab et du tri suivent le format de prompt actuel.
- **La revue de merge request GitLab trouve son runner** : elle le cherchait dans le dossier `.workpilot` du projet, où il n'est pas, et s'arrêtait toujours sur « GitLab runners not found ». Les revues GitHub et GitLab cherchent maintenant leur runner au même endroit, dans le backend de l'application.
- **Les revues de PR restent dans le projet et suivent les instructions de l'app** : les
  relecteurs GitHub, GitLab et Azure DevOps lisent le dossier du projet relu, même quand il
  s'appelle `backend` ; la revue Azure DevOps prend ses instructions dans l'app et non dans le
  dépôt relu ; le titre, la description, le diff, les branches, l'auteur et les fichiers d'une
  MR GitLab ou d'une PR Azure DevOps sont cités par l'assistant commun, comme sur GitHub ; les
  relecteurs et le tri des issues travaillent sur le contenu du dépôt, sans recherche web.
- **Tri et regroupement des issues GitHub** : le titre, le corps, l'auteur et les étiquettes
  d'une issue sont cités par l'assistant commun ; le relecteur de suivi et le tri tournent en
  lecture seule ; l'auteur d'une étiquette se retrouve même sur une issue très active ; une
  référence de PR commence toujours par une lettre ou un chiffre. Le texte cité perd les
  caractères qu'un lecteur ne voit pas (contrôle, largeur nulle, étiquettes Unicode).
- **Les vues GitHub, GitLab, CI/CD et Git montrent le projet de l'onglet affiché.** Après la
  fermeture de l'onglet affiché, l'ouverture d'un nouvel onglet ou un redémarrage, certaines vues
  restaient sur un autre projet : la vue « PRs GitHub » de l'onglet « Dotnet » listait les pull
  requests de WorkPilot-AI. Le projet sélectionné suit désormais l'onglet actif, et une réponse
  arrivée après un changement de projet (dépôt, PR, issues) n'est plus affichée.
- **Formula Lab** : sélectionner une carte de suggestion ne l'affiche plus comme « Appliquée » et ne désactive plus son bouton ; seule la formule réellement appliquée à la tâche porte cette mention, quelle que soit sa carte. Les niveaux d'effort et le pourcentage de réussite lu par un lecteur d'écran s'affichent en français. Ouvrir le laboratoire sur une autre tâche pendant un calcul, un affinage IA ou un enregistrement n'y affiche plus le résultat de la tâche précédente. Les en-têtes de tri, les filtres d'effort, la recherche, le choix du fournisseur et chaque ligne du tableau sont utilisables au clavier et nommés pour un lecteur d'écran.
- **Idéation** : le statut, l'effort, la gravité, l'impact, la priorité, le public cible et la
  catégorie d'une idée s'affichent en mots traduits au lieu de leur code (`high`, `archived`) ou
  d'un libellé anglais ; le panneau d'une idée convertie propose « Aller à la tâche » au lieu de
  la convertir une seconde fois, suit l'idée telle qu'elle est maintenant et se ferme au
  changement de projet ; un arrêt de génération qui échoue est signalé ; les logs montrent
  chaque ligne, même répétée, et suivent la dernière ; une idée sans métriques n'affiche plus de
  bloc « Métriques » vide ni un « 0 » isolé ; une référence de sécurité qui n'est pas une adresse
  web reste du texte ; « 1 idée » et « Générer 1 type » sont au singulier ; les interrupteurs de
  la configuration ont un nom lisible par les lecteurs d'écran et les types à ajouter sont des
  boutons accessibles au clavier.
- **Marketplace MCP** : un catalogue qui ne se charge pas, une installation, un retrait ou une
  sauvegarde du constructeur qui échoue est maintenant signalé (dans la fenêtre d'installation
  quand elle est ouverte), en français comme en anglais, au lieu de ne rien dire.
- **Marketplace MCP** : changer de projet n'affiche plus les serveurs installés, ni le score de
  sécurité, lus pour le projet précédent ; retirer un serveur le retire du projet dont la liste
  a été lue.
- **Marketplace MCP** : la catégorie Sécurité est proposée dans les filtres, et un registre
  illisible sans motif est signalé dans le détail du score.
- **Constructeur MCP** : taper le nom d'un paramètre ne fait plus perdre le curseur à chaque
  lettre, supprimer un serveur qui n'a pas pu l'être le laisse ouvert, et les types d'action et
  de paramètre sont traduits.
- **Accessibilité** : les champs de la fenêtre d'installation et du constructeur sont reliés à
  leur libellé, et les boutons afficher la valeur, aide, ajouter un outil et supprimer un
  paramètre ont un nom lisible par un lecteur d'écran.
- **Marketplace de plugins** : en changeant de projet, la liste des plugins installés est celle du projet choisi, même si la lecture du précédent répond plus tard, et le catalogue ne propose plus de désinstaller dans ce projet un plugin de l'autre ; une lecture refusée des plugins installés est affichée au lieu d'une liste vide silencieuse ; les erreurs du catalogue, de l'installation et de la désinstallation sont traduites ; la recherche, le tri, les filtres et le bouton de désinstallation de chaque plugin ont un nom lisible par un lecteur d'écran.
- **Création de plugin** : les types sont nommés en toutes lettres et traduits ; l'identifiant doit être un nom de dossier valide (minuscules, chiffres, tirets) avant de continuer ; l'aperçu montre le `plugin.config.json` réellement écrit, sans valeurs inventées ; une copie refusée, un échec de création ou d'ouverture du dossier est affiché et traduit ; chaque champ est relié à son libellé.
- **Formulaire de tâche** : une capture d'écran jointe à une tâche est enregistrée comme une image
  PNG lisible et s'affiche en grand ; le raccourci de collage s'affiche correctement (`⌘V` sur
  macOS) ; le message de limite donne le vrai nombre d'images autorisées et celui de type refusé
  liste les formats acceptés (SVG compris) ; une image collée ou déposée pendant qu'une autre est
  ajoutée ou que les miniatures se chargent n'efface plus les autres, et une miniature lue depuis
  le disque s'affiche même si la liste change pendant sa lecture ; une image SVG collée garde
  l'extension `.svg` ; la miniature d'une image s'ouvre d'un clic ou au clavier ; dans l'éditeur
  enrichi, un lien posé sur des mots sélectionnés porte sur ces mots au lieu d'insérer l'adresse
  à côté, et le champ Description a un nom pour les lecteurs d'écran ; fermer la fenêtre de
  création ou d'édition par son bouton ne déclenche plus la fermeture deux fois.
- **Fonctions avancées** : changer de projet efface les résultats du précédent (scores, santé des
  agents, dérive, licences, audit) et une réponse encore en route pour lui n'arrive plus sous le
  nom du nouveau. L'audit revient aux événements après un rejeu, dit quand une piste ou un rejeu
  est vide et nomme la rupture d'intégrité en français ; le routage de modèles nomme le provider
  choisi, les tests générationnels nomment le format lu, et une copie ou une boîte de dialogue
  qui échoue est signalée. L'éditeur de traductions affiche son erreur une seule fois et
  traduite, dit pourquoi un renommage est refusé, et une case manquante annulée redevient
  manquante ; un nom sans lettre latine rejoint une salle de pair programming sous l'id `me`.
- **Fichiers d'une pull request** : la fenêtre dit pourquoi une PR ne s'affiche pas (lien qui n'est pas une PR, échec, réponse vide) dans la langue de l'app, au lieu d'un message anglais ou d'une fenêtre vide ; l'état de la PR s'écrit « Ouverte » ou « Fermée » ; la réponse d'une PR qu'on a quittée ne remplace plus celle qu'on regarde ; le bouton s'appelle « Ouvrir dans le navigateur » aussi pour Azure DevOps ; chaque fichier se déplie au clavier.
- **Limite d'usage d'un terminal** : choisir un autre compte n'est plus annulé aussitôt par le compte suggéré, et la fenêtre ne recharge plus les profils en boucle ; « Ajouter un compte » place le curseur dans le champ du nom aussi en français ; un compte refusé, un changement de compte manqué ou un réglage de basculement automatique non enregistré sont signalés ; la fenêtre se ferme une fois le compte changé.
- **Configuration GitHub d'un nouveau projet** : le bouton de fermeture ferme la fenêtre ; un résultat de test de connexion disparaît dès qu'on modifie le dépôt ou le jeton, et la réponse d'un test lancé avec d'autres valeurs est ignorée.
- **Initialisation de Git** : l'échec sans raison donnée s'affiche en français ; la fenêtre ne rappelle plus la page après avoir été fermée par elle.
- **Bannière de mise à jour** : une mise à jour déjà téléchargée reste prête à installer quand la même version est annoncée de nouveau, et la barre de téléchargement est lisible par un lecteur d'écran.
- **Pair Programming** : le fil de discussion et la sortie de l'IA défilent quand de nouveaux messages arrivent ; une session lancée dans un autre projet n'apparaît plus sur la page du projet courant ; un démarrage ou un arrêt qui échoue le dit au lieu de laisser la page en « planification » ; les messages d'état écrits par l'application sont traduits.
- **Refactoring** : un collage refusé par le presse-papiers est signalé ; vider ou remplacer le code pendant une analyse écarte la réponse qui concernait l'ancien code.
- **Historique des conversations (Insights)** : « Aujourd'hui » et « Hier » suivent les jours du calendrier ; un renommage ou une suppression qui échoue est signalé ; chaque conversation est un vrai bouton, utilisable au clavier, et le champ de titre a un nom pour les lecteurs d'écran ; une conversation d'un collègue, en lecture seule, ne propose plus de la renommer ni de la supprimer.
- **Moteur de la page** : « Comme les réglages » montre le fournisseur, le modèle et l'effort des réglages, et non le choix propre à la page ; un choix qui n'a pas pu être enregistré est signalé ; les trois listes portent leur libellé.
- **Analyse de la qualité du code** : chaque catégorie dit si elle est dépliée.
- **Téléchargements de modèles** : le panneau flottant annonce un échec dans son en-tête (et non « 1 téléchargement terminé » à côté d'une icône rouge), dit le temps restant en français (« encore 2 min »), et son bouton « effacer » n'est plus imbriqué dans le bouton qui replie le panneau.
- **Compaction de session** : le résumé d'une longue tâche et le nom de la phase en cours s'affichent dans la langue de l'app, au lieu d'un texte anglais en dur.
- **Modèle personnalisé** : les niveaux de réflexion et leurs descriptions sont traduits.
- **Explorateur de fichiers** : l'arborescence du projet s'affiche de nouveau dans le panneau des fichiers et à côté de l'assistant de création de tâche (seul le bouton « Dossier parent » apparaissait) ; un dossier illisible le dit sans relancer la lecture en boucle ni masquer le reste de l'arbre ; le bouton « Dossier parent » du choix de dossier remonte d'un niveau sous macOS et Linux comme sous Windows, et n'apparaît plus là où il ne faisait rien.
- **Kanban** : la durée d'inactivité d'une carte s'écrit dans la langue de l'application (« Idle for 2d » en anglais, « Inactive depuis 2j » en français).
- **Roadmap** : la complexité et l'impact d'une fonctionnalité sont traduits sur sa carte, et une fonctionnalité importée d'une issue GitHub indique « Importé depuis GitHub ».
- **Composants du frontend, lot F5AJ** : les cartes déplaçables du Kanban et de la roadmap, l'explorateur de fichiers et la palette, les blocs et les connexions du canvas d'architecture sont rendus et utilisés par leurs tests.
- **Raccourcis clavier (Ctrl+/)** : la fenêtre des raccourcis est traduite et liste les
  raccourcis réels : ceux du menu à deux lettres (lus dans le menu tel qu'il est affiché) au
  lieu d'une liste à une touche périmée, et Ctrl+T pour un nouveau terminal au lieu de
  Ctrl+Shift+T ; sa croix a un nom lisible par les lecteurs d'écran.
- **Capture d'écran** : une fenêtre dont le titre contient « screen » ou « display » n'est
  plus présentée comme un écran ; un échec de capture s'affiche en français suivi du détail
  donné par l'application ; chaque source dit si elle est un écran ou une fenêtre et si elle
  est choisie, et le bouton « Réessayer » de l'erreur a un nom lisible.
- **Outils CLI (REA, Hermes)** : une vérification de REA qui échoue dit pourquoi au lieu de
  montrer seulement « Non installé » ; un lien vers la documentation d'Hermes qui ne s'ouvre
  pas le dit ; dans la barre latérale repliée, les boutons REA et Hermes ont un nom lisible.
- **Profil d'agent** : les profils prédéfinis (Tâches complexes, Équilibré, Modifications rapides…), leurs descriptions et les niveaux de réflexion s'affichent dans la langue de l'app ; la liste des profils écrit « Élevé » ou « Ultra Think » au lieu de la valeur brute (`high`), et chaque liste de modèle ou de réflexion d'une phase porte le nom de sa phase pour un lecteur d'écran.
- **Badge d'authentification** : un fournisseur sans nom connu (LM Studio, fournisseur personnalisé) garde son nom au lieu d'un badge vide, un profil d'adresse inconnue dit « Inconnu » en français, et l'état de GitHub CLI ou du compte Windsurf ne s'affiche plus pour un fournisseur quitté entre-temps.
- **Badges des CLI** : un échec de mise à jour de Codex CLI s'affiche en français ; la seconde vérification qui suit une mise à jour n'a plus lieu une fois le badge fermé ; un agent CLI installé sans vérification jointe est revérifié et passe à « Installé ».
- **Remote Azure DevOps** : le bouton de fermeture ferme la fenêtre, une adresse refusée le dit dès la saisie, et les champs de l'adresse et du jeton sont nommés pour un lecteur d'écran.
- **Documentation** : la ligne de progression d'une analyse reste à jour quand on quitte l'onglet
  puis qu'on y revient, et l'échec d'une analyse lancée sur un autre projet ne s'affiche plus sur
  le projet ouvert.
- **Création de PR en lot** : Échap ou la croix arrêtent bien les PR restantes, et une branche
  cible invalide dit pourquoi le bouton est désactivé.
- **Fournisseur par défaut** : la demande d'authentification et la redirection vers les comptes
  nomment le fournisseur au lieu d'afficher `{{provider}}`.
- **Insights** : la réponse en cours de rédaction défile avec la conversation, un échec de
  création de la tâche suggérée est signalé, et les badges de catégorie et de complexité sont
  traduits.
- **Grille de terminaux** : changer de projet referme le terminal agrandi au lieu de masquer la
  grille du nouveau projet.
- **Génération de tests** : le sélecteur de fichier ouvre bien le dossier du fichier déjà choisi
  (racine comprise), reste utilisable quand un dossier ne se lit pas, et ses boutons d'effacement
  ont un nom lisible par un lecteur d'écran ; le champ de destination personnalisée aussi.
- **Studio de tests** : la coloration du code reconnaît un attribut Rust (`#[test]`), garde un
  décrément (`i--`) comme du code, et ne colle plus une chaîne ou un attribut à la ponctuation
  qui le précède ; « Copié » ne s'affiche qu'une fois la copie réussie.
- **Issues GitHub** : l'état, la complexité et le nombre de commentaires d'une issue sont
  traduits, comme les messages de liste vide, d'erreur et le filtre ; une recherche ne charge
  plus les issues deux fois ; la page suivante se charge aussi quand la première arrive très
  vite ; une vérification de connexion qui échoue dit pourquoi et n'affiche plus le dépôt du
  projet précédent.
- **Regrouper les issues** : ce sont bien les lots validés qui sont cochés d'office, un échec
  de création des tâches s'affiche sans perdre la sélection au lieu de laisser l'assistant
  bloqué, et les cases des lots ont un nom lisible par un lecteur d'écran.
- **Créer une tâche depuis une issue** : un échec de lecture des commentaires est signalé au
  lieu de laisser croire que l'issue n'en a pas.
- **Pull requests GitHub** : le filtre de statut range chaque PR sous le libellé que la liste lui
  donne (une PR « Prête à fusionner » n'en disparaît plus) ; la liste dit quand une PR a bougé
  dans la langue de l'app et signale qu'aucune PR ne correspond au filtre au lieu de « Aucune
  pull request ouverte » ; le compteur, l'état d'une PR, l'état de ses fichiers et les catégories
  des résultats de revue sont traduits.
- **Revue d'une PR** : les cartes de la page s'ouvrent au clavier, une sévérité entière se coche
  au clavier, Entrée sur un contributeur ne coche plus aussi celui que le clavier survole, les
  boutons à icône (lien GitHub, actualiser, réinitialiser, détail d'une erreur) ont un nom lisible
  par un lecteur d'écran.
- **Journal de revue** : deux lignes écrites dans la même seconde s'affichent toutes les deux ;
  les phases et le résumé des outils sont traduits ; le contexte profond garde deux règles
  enfreintes dans un même fichier et ne montre plus de carte vide.
- **Page d'une PR GitHub** : ouvrir une autre PR repart d'une page neuve, donc une revue publiée,
  un journal ou une erreur de la PR précédente ne s'affichent plus sur la suivante, et une
  publication encore en cours pour l'ancienne PR n'écrit plus dans la nouvelle ; la carte des
  workflows d'une PR venue d'un fork, qui ne s'affichait jamais, liste et approuve de nouveau
  ses exécutions ; après « Mettre à jour la branche », l'avertissement de fusion est relu au lieu
  de rester affiché ; une revue « propre » ou un statut que GitHub refuse n'est plus annoncé comme
  publié ; le message d'approbation posté sur GitHub n'a plus de caractères illisibles, et le
  bouton d'approbation accorde « suggestion » au singulier.
- **Merge requests GitLab** : ouvrir une autre MR repart d'une page neuve, donc les constats
  publiés ou sélectionnés sur la précédente ne s'affichent plus sur la suivante ; un constat
  publié depuis la page et déjà listé par la revue n'est plus compté deux fois ; après une
  première publication, la revue de suivi proposée quand de nouveaux commits sont arrivés ne
  disparaît plus au bout d'une demi-seconde ; une vérification des commits qui échoue ne laisse
  plus d'erreur non traitée ; l'état de la MR, son statut de fusion, les filtres de la liste et
  les sévérités des constats sont traduits (les libellés anglais des sévérités étaient en
  français) ; la recherche de la liste trouve aussi une branche ou un numéro `!42` ; la case
  « tout sélectionner » d'un groupe de constats et le lien vers GitLab de chaque ligne
  s'atteignent au clavier ; la vue en erreur propose d'ouvrir les paramètres ; le formulaire de
  création de MR a des messages traduits et des champs à lui.
- **API Explorer, panneau de requête** : « Obtenir un nouveau jeton » OAuth 2.0 passe par le
  processus principal comme les autres requêtes (l'appel direct était bloqué par la politique de
  sécurité de la fenêtre et n'aboutissait jamais) ; une authentification Basic avec un accent ou
  un symbole (« é », « € ») s'envoie au lieu de laisser le bouton Envoyer bloqué ; une requête
  impossible à construire termine l'envoi ; une requête refusée montre la raison du refus ; la
  coloration du JSON colore enfin les clés et les chaînes ; un `$ref` qui contient `~1` ou `~0`
  se résout ; copier la réponse dit quand le presse-papiers refuse ; les champs de l'onglet Auth
  sont reliés à leur libellé, et les boutons d'icône (afficher la valeur, copier, cocher ou
  retirer une ligne) sont nommés pour un lecteur d'écran ; le flux « Authorization Code » ne
  promet plus PKCE, qu'il ne fait pas, et ses libellés sont traduits en français.
- **API Explorer** : plusieurs environnements importés d'un coup ont chacun leur identifiant
  (ils partageaient le même, donc modifier ou supprimer l'un touchait les autres) et arrivent
  dans l'ordre où ils ont été trouvés ; supprimer l'environnement actif bascule sur un
  environnement qui existe encore ; l'export Postman garde les requêtes sans étiquette et écrit
  les exemples d'en-tête tels quels ; la documentation Markdown ne casse plus un tableau quand
  une description contient un `|` et n'affiche plus les paramètres communs d'un chemin comme
  un endpoint ; copier le contrat dit quand le presse-papiers refuse ; une erreur de chargement
  du contrat ne commence plus par « Error: » ; l'environnement par défaut détecté, le libellé
  Markdown et les boutons sans texte (fermer, modifier, supprimer, afficher le jeton, effacer
  la recherche, charger le contrat) sont traduits et nommés pour un lecteur d'écran ; les deux
  fenêtres sont annoncées comme des boîtes de dialogue.
- **Bureau Pixel** : la bulle d'une sous-tâche d'essaim ne propose plus « Voir dans Kanban »
  ni « Arrêter », qui n'avaient aucune carte sur laquelle agir ; le bouton qui ferme un
  terminal s'appelle « Fermer le terminal » et ne se confond plus avec la fermeture de la
  bulle ; copier les logs dit quand le presse-papiers refuse au lieu de ne rien faire ; les
  pauses pour limite d'usage ou échec d'authentification ne nomment plus un seul provider ;
  la touche Échap ne ferme plus la bulle deux fois ; le bouton d'envoi d'une commande et le
  dépliage des logs sont nommés pour un lecteur d'écran ; les raccourcis clavier du bureau
  s'affichent au survol.
- **Terminaux** : « Annuler » dans la création d'un worktree vide le formulaire, comme Échap,
  au lieu de le rendre tel quel à l'ouverture suivante ; quand la branche n'a pas pu être
  poussée, l'avertissement explique la suite dans la langue de l'app plutôt que de citer git ;
  la liste des worktrees dit quand elle n'a pas pu être lue (la liste des tâches comprise) et
  quel worktree n'a pas pu être supprimé ; la confirmation de suppression dit si la branche
  part aussi, et reste ouverte, verrouillée, jusqu'à la fin de la suppression ; la phase de la
  tâche liée est traduite et une phase inconnue ne casse plus l'en-tête ; copier sans accès au
  presse-papiers système passe par la copie du navigateur au lieu de se dire réussi sans rien
  copier ; le choix de la tâche à lier est nommé pour un lecteur d'écran.
- **Terminaux** : quand le shell n'a pas pu être recréé en passant dans un worktree, il est
  réessayé pendant trois secondes puis l'échec est signalé, au lieu de laisser le terminal
  sans shell et sans message ; le nommage automatique suit le passage en mode Claude et les
  réglages modifiés sans qu'il faille rouvrir le terminal ; « Processus terminé avec le code… »
  s'affiche dans la langue de l'app ; « Réduire le terminal » prend son accent.
- **Réglages du projet** : désactiver Linear, GitHub, GitLab ou Azure DevOps efface le dernier
  état de connexion au lieu de le laisser affiché ; la connexion GitHub par la CLI abandonne
  bien au bout de cinq minutes sans réponse (le délai était annulé dès l'affichage suivant) et
  transmet le compte déjà connecté ; la connexion Claude ne rappelle plus l'écran suivant une
  fois la fenêtre fermée ; un changement de dossier, un terminal qui ne s'ouvre pas ou une
  branche principale introuvable le disent au lieu de ne rien faire ; la recette du worktree
  dit quand elle n'a pu être ni lue ni enregistrée ; les messages d'erreur de ces écrans sont
  traduits, les boutons « Copier » et l'affichage d'un secret sont nommés pour un lecteur
  d'écran, et les interrupteurs des réglages généraux sont reliés à leur libellé.
- **Visual to Code** : pendant une génération, le panneau du code annonce « Génération… » dans
  la langue de l'application au lieu de la ligne de progression anglaise du backend ; une
  connexion inhabituelle propose les blocs à intercaler avec la conjonction de la langue du
  canvas ; enregistrer une brique supprimée entre-temps le dit au lieu de ne rien faire ; le
  panneau du code et les onglets du hub ne se redessinent plus à chaque changement du store.
- **Visual to Code** : quand l'onglet « Import de design » est affiché, Suppr, Retour arrière et
  Ctrl+Z ne modifient plus le canvas caché derrière lui, et une touche pressée dans une boîte de
  dialogue ouverte sur le canvas n'efface plus la sélection ; « Générer le projet » crée la tâche
  dans le projet que la boîte de dialogue affichait, même si un autre projet est devenu actif
  entre-temps ; les messages « pont absent » et « erreur inconnue » sont traduits.
- **Import de design** : quand la tâche Kanban ne peut pas être créée, un message le dit et le
  bouton permet de réessayer, au lieu de revenir à son état initial sans rien dire ; une copie
  refusée par le presse-papiers affiche « Copie refusée » ; Échap dans la phrase entre deux étapes
  annule la modification sans l'enregistrer.
- **Assistant de démarrage** : un profil d'API qui pointe vers un serveur Ollama local est
  reconnu comme Ollama sur le dernier écran ; une erreur d'enregistrement de l'étape
  Confidentialité est annoncée aux lecteurs d'écran. Deux écrans jamais affichés (premier
  ticket, choix d'un modèle Ollama) et leurs textes sont supprimés.
- **Visite guidée** : l'attente d'un élément rend la main tout de suite quand la visite est
  déjà fermée, au lieu de ne jamais répondre.
- **Assistant de démarrage, comptes IA** : un chargement, un ajout, une suppression, un
  renommage ou un changement de compte actif refusé est maintenant annoncé au lieu de ne rien
  faire ; les messages d'erreur sont traduits en anglais et en français ; l'adresse du compte
  n'est plus écrite dans la console ; les boutons à icône (valider, annuler, afficher le jeton)
  ont un nom lisible par les lecteurs d'écran.
- **Assistant de démarrage, CLI IA** : la nouvelle vérification qui suit une installation est
  abandonnée si l'écran se ferme ; une vérification ratée ne s'affiche plus deux fois ; le
  bouton d'actualisation a un nom lisible.
- **Assistant de démarrage, outils** : « Terminal du système », « Personnalisé » et l'erreur
  d'enregistrement sont traduits ; les terminaux détectés ne sont plus filtrés deux fois.
- **Administration (mode serveur)** : changer d'organisation recharge l'onglet ouvert au lieu
  de garder les membres, groupes ou quotas de l'organisation précédente ; un changement
  d'organisation refusé par le serveur est affiché dans le bandeau d'erreur au lieu de ne rien
  faire ; le formulaire « Nouveau rôle » repart vide à chaque ouverture ; le bouton de
  suppression d'un rôle a un nom lisible par les lecteurs d'écran, et l'icône des permissions
  à privilège est annoncée.
- **Connexion à un serveur et invitations** : une connexion, une invitation ou une création de
  compte qui échoue sans raison du serveur affiche un message dans la langue de l'app au lieu de
  rester sans réponse ; Entrée dans le champ mot de passe ne tente plus de connexion tant que
  l'adresse et l'e-mail ne sont pas remplis ; la liste des invitations affiche le rôle traduit ;
  le bouton de copie du lien a un nom lisible par les lecteurs d'écran et signale une copie
  refusée ; la réponse d'un serveur que l'on vient de changer n'écrase plus la nouvelle.
- **Import Jira et Azure DevOps** : les panneaux d'import et la fenêtre d'import Azure DevOps
  vérifiaient la connexion (et relisaient la liste après un échec) à chaque rendu tant qu'ils
  étaient ouverts ; ils la vérifient une fois à l'ouverture. Une recherche entourée d'espaces
  trouve l'élément qu'elle vient de charger ; le compteur « +N » de la sélection Azure DevOps
  s'affiche correctement ; la confirmation d'un import Jira parle de tickets et affiche leur clé
  (`PROJ-1`, plus `#PROJ-1`) ; un import Azure DevOps qui n'importe rien dit pourquoi ; changer de
  projet ne garde plus la liste ni la largeur du projet précédent ; les boutons du panneau
  (réduire, fermer, rafraîchir) ont un nom traduit et lisible par les lecteurs d'écran.
- Les deux panneaux et la fenêtre partagent maintenant un même composant
  (`components/work-item-import/`) au lieu de trois copies.
- **Dette technique** : changer de projet affiche les éléments de ce projet, son chemin et rien
  du précédent, et une réponse arrivée pour le projet quitté est ignorée ; la tâche créée depuis
  un élément va au projet pour lequel la liste a été lue, pas au chemin tapé depuis ; sans projet,
  ou quand la tâche n'a pas pu être créée, le tableau de bord le dit au lieu de ne rien faire ;
  une seule tâche se crée à la fois ; le filtre cherche aussi dans les étiquettes, comme
  l'annonce son exemple ; un seul scan trace une ligne au lieu d'un point invisible.
- **Roadmap** : la priorité, la complexité, l'impact, la gravité d'un point de friction et
  le statut d'une phase ou de la roadmap s'affichent dans la langue de l'app au lieu de leur
  code (`must`, `in_progress`…) ; « 1 fonctionnalité » s'accorde au singulier et la cible
  s'écrit « Target: » en anglais ; une fonctionnalité qui n'a pas pu devenir une tâche le dit
  au lieu de laisser un bouton sans effet, comme une sauvegarde de la roadmap qui échoue ; les
  lignes d'une phase s'ouvrent au clavier.
- **Roadmap** : ajouter une fonctionnalité dont la sauvegarde échoue la retire du tableau au
  lieu de la laisser comme si elle était enregistrée ; la boîte d'ajout propose les priorités,
  complexités et impacts dans la langue de l'app ; une fonctionnalité ajoutée à la main a une
  justification traduite ; les cartes du kanban disent leur complexité, leur impact et leur
  source (Canny, GitHub Issues) dans la langue de l'app ; l'analyse concurrentielle traduit la
  gravité et « récemment » ; la dernière activité d'une génération s'écrit dans la langue de
  l'app (« il y a 5 min »).
- **Mode Arena** : un combat continue de recevoir les réponses des modèles quand on change
  d'onglet ou qu'on ferme la fenêtre ; un vote refusé, un combat en échec, un historique ou des
  statistiques illisibles et un historique qui ne s'efface pas affichent leur raison au lieu de ne
  rien faire ou de montrer une liste vide ; seul le bouton « Voter pour celui-ci » enregistre un
  vote (sélectionner du texte d'une réponse n'en compte plus un) et il nomme le modèle concerné ;
  l'interrupteur de routage automatique, qui ne changeait rien, est retiré de l'onglet des
  recommandations ; le nombre de combats s'accorde au singulier ; les champs et les choix du
  formulaire ont des noms lisibles par les lecteurs d'écran.
- **Mission Control** : le statut, le rôle et le niveau de modèle d'un agent s'affichent en français (« En cours », « Développeur », « Rapide ») au lieu des codes anglais ; les tokens s'écrivent selon la langue de l'app et le coût n'affiche plus deux signes dollar. Un agent refusé par le backend laisse la fenêtre d'ajout ouverte, avec ce qui a été saisi et la raison du refus, et un double clic ne crée plus deux agents. Dans l'arbre de décision, Entrée et Espace replient enfin une branche, et un arbre incomplet ne fait plus planter la page. Les boutons du menu, de démarrage et d'arrêt d'un agent ont un nom lisible par un lecteur d'écran, et le nom de l’agent est un vrai bouton pour le sélectionner. Un fichier au chemin Windows est nommé par son nom seul, et deux agents qui démarrent au même instant gardent chacun leur ligne dans le journal.
- **Réglages → Comptes** : à l'ouverture, un fournisseur configuré jamais testé l'est une seule
  fois, au lieu d'être retesté à chaque rafraîchissement de la liste pendant les tests des autres.
  « Réessayer » relance le chargement au lieu de recharger toute la fenêtre. Couper un
  fournisseur de la bascule automatique ne s'affiche plus comme fait quand l'enregistrement
  échoue, et les messages nomment le fournisseur par son nom.
- **Bascule automatique** : ouvrir le panneau ne relit plus l'ordre des comptes et les profils
  Claude en boucle. Le seuil de session suit le curseur et s'enregistre une fois relâché, au lieu
  d'enregistrer chaque cran et de bloquer le curseur pendant le glissement. Un réglage qui n'a pas
  pu être enregistré revient à sa valeur enregistrée, un ordre des comptes refusé le dit et la
  liste reprend l'ordre enregistré, et chaque interrupteur porte le nom de son libellé. La poignée
  de chaque compte de la liste de priorité nomme le compte, et l'aide d'un compte à reconnecter ne
  propose plus un clic qui ne faisait rien.
- **Terminaux de connexion** (Claude, Codex, outils en ligne de commande, GitHub Copilot) : un
  terminal fermé pendant sa création ne reste plus ouvert en arrière-plan. La connexion Codex
  n'affiche plus une fausse adresse « Codex CLI User ». Copilot reconnaît la ligne finale de
  `gh auth login` (« Logged in as … ») et son compte, et une connexion ratée peut être relancée
  dans le même terminal. Le bouton de fermeture a un nom lisible par les lecteurs d'écran.
- **GitHub d'un projet** : un jeton obtenu par la connexion GitHub rouvre la liste des dépôts au
  lieu du champ de jeton manuel. Les interrupteurs, le jeton, le dépôt et les boutons
  d'actualisation ont un nom lisible par les lecteurs d'écran.
- **Azure DevOps d'un projet** : la liste des dépôts est lue une fois, au lieu d'être relue à
  chaque rendu, et le dépôt du remote git n'est détecté qu'une fois par projet ; une détection
  arrivée après un changement de projet n'est plus appliquée à l'autre. Un dépôt enregistré absent
  de la liste reste affiché. Les champs, interrupteurs et le bouton d'affichage du jeton ont un nom.
- Retiré, avec la preuve : un bouton « supprimer » de carte de fournisseur qui ne faisait rien
  et qu'aucune carte n'affichait, une branche Windsurf OAuth que le registre rend impossible, et
  des données d'usage jamais remplies. Ces écrans sont testés par leur comportement.
- **Détection du fournisseur Git** : la détection GitHub / Azure DevOps des projets repartait à
  chaque rendu de la fenêtre (une lecture de configuration par projet à chaque fois) ; elle ne
  tourne plus que quand la liste des projets change.
- **Retirer un projet** : un retrait refusé fermait le dialogue comme s'il avait réussi, et
  ramenait au Kanban quand c'était le dernier projet ; le dialogue reste ouvert avec l'erreur.
- **Ajouter un projet avec Ctrl+T** : l'avertissement « dossier qui n'est pas la racine git »
  s'affichait en anglais ; il suit la langue de l'app.
- **Kanban, carte mise en avant** : la carte sur laquelle on saute depuis une autre vue cesse de
  clignoter au bout de deux secondes, au lieu de rester allumée.
- **Kanban, pause** : le bouton Pause d'une carte devient Reprendre dès que la tâche est en pause.
- **Kanban, badges** : le verdict de vérification, la revue croisée et les bloqueurs s'affichent
  aussi sur une carte qui n'a pas d'autres métadonnées.
- **Kanban, colonne « Build rouge »** : elle a sa couleur rouge au lieu du gris du backlog.
- **Kanban en français** : les priorités et catégories des cartes et du panneau de filtres sont
  traduites (elles restaient en anglais).
- **Commandes rapides** : un échec sans message n'affiche plus « unknown » sous le titre.
- **Fichiers modifiés d'une tâche** : un fichier qui n'a pas pu être lu n'ouvre plus un éditeur
  vide, dont l'enregistrement écrasait le fichier par un texte vide ; Enregistrer attend que le
  fichier soit lu. Abandonner des fichiers (retour à la branche de base, nouveaux fichiers
  supprimés) demande un second clic, garde sélectionnés ceux qui n'ont pas pu l'être, et ses
  messages sont traduits. Un enregistrement ou un ajout de fichier raté le dit au lieu de
  seulement l'écrire dans les journaux.
- **Fichiers d'une sous-tâche** : l'éditeur ne prétend plus modifier le contenu des fichiers ; il
  retire du plan les fichiers que la sous-tâche doit laisser, et le dit. La visionneuse compte
  les lignes de la sous-tâche seule (et non de toute la branche) et garde la liste des fichiers
  prévus quand le worktree ne donne pas de diff.
- **Carte de tâche** : catégorie, priorité, complexité, impact, gravité et type d'idée sont
  traduits ; une synchronisation des critères d'acceptation ou une note qui échoue le dit. Les
  prérequis proposés montrent leur colonne. Ces écrans sont testés par leur comportement.
- **Modifier le plan d'une tâche** n'écrase plus le plan : l'enregistrement depuis l'onglet
  Sous-tâches gardait une seule phase, renommait les champs et réécrivait les sous-tâches déjà
  lancées. Seules les sous-tâches en attente changent désormais, les phases du planificateur
  restent, et la tâche affichée ne bouge pas avant que l'enregistrement réussisse (il reste ouvert
  s'il échoue).
- **Demander des modifications du plan** laisse enfin écrire la raison : le champ n'apparaissait
  que pendant l'envoi. Un premier clic l'ouvre, un second envoie, Annuler le referme.
- **Fenêtre de tâche** : le texte et les images d'une demande de modifications ne passent plus à
  la tâche suivante ; le choix de la formule d'exécution est proposé de nouveau pour la tâche
  suivante ; une tâche ne se ferme plus quand son passage à « terminé » est refusé ; les
  messages, erreurs, gravités de conflit et boutons à icône ont leur texte en français et en
  anglais (« 1 fichier », « 1 commit ») et un nom lisible par les lecteurs d'écran.
- Retiré, avec la preuve : un résumé d'aperçu de fusion qu'aucun écran n'importait, et ses textes.
  La fenêtre de tâche, la revue (messages du worktree, état, retours de QA, confirmations), le plan
  et les sous-tâches sont testés par leur comportement.
- **Carte du Kanban** : quand le tableau donnait à une carte une nouvelle action (clic, changement de statut, sélection, suppression…) sans que la tâche ait changé, la carte gardait l'ancienne. Elle utilise toujours la dernière.
- **Phase en cours** : la pastille de phase de la carte (Planification, Codage, Révision…) suit la langue de l'app au lieu de rester en anglais.
- **Récupération d'une tâche bloquée** : un échec de la récupération s'affiche dans une notification avec sa raison ; la carte reste marquée bloquée.
- **Téléchargement d'un modèle local** : le temps restant dans l'infobulle de la pastille de téléchargement est écrit dans la langue de l'app (« encore 3 min »).
- Code inutilisé retiré : l'ancien bloc de progression du panneau de tâche, que plus rien n'affichait, et ses textes ; deux sélecteurs du store des téléchargements que rien n'appelait.
- **Issues GitLab dans la langue de l'app** : l'état d'une issue (« Ouverte », « Fermée »), la
  liste vide, les échecs de chargement et de vérification de la connexion, la création d'une
  carte depuis une issue et la boîte « Créer une tâche » (étape en cours, échec puis sa raison)
  s'affichent en français ou en anglais. Une lecture des notes qui échoue est signalée au lieu de
  passer pour une issue sans notes, et une réponse arrivée après avoir changé de projet n'affiche
  plus la connexion ou les issues du projet quitté.
- **Persona hermes remplaçable** : quand un autre `SOUL.md` est déjà installé, le panneau de la
  tâche propose de le remplacer (l'ancien est gardé avec un horodatage) ; ce bouton n'apparaissait
  jamais.
- **Capture d'écran** : quand la liste des écrans ou la capture échoue, la raison s'affiche dans
  la langue de l'app (droit d'enregistrer l'écran, fenêtre qui n'existe plus, capture à refaire).
- **Marketplace MCP** : la raison d'un échec venue de l'application (enregistrement ou
  suppression d'un serveur du constructeur, score de sécurité) est écrite en français comme en
  anglais ; un enregistrement du constructeur que le disque refuse est signalé au lieu de passer
  pour réussi.
- **Formula Lab** : les fournisseurs sont nommés comme dans les réglages (« OpenAI (ChatGPT) »,
  « Anthropic (Claude) »…) dans le tableau, les cartes, le graphique et le filtre, et la
  recherche les trouve sous ce nom.
- **Mission Control** : le modèle « Autre (saisie libre) » s'affiche « Other (free text) » en
  anglais dans la fenêtre d'ajout d'un agent.
- **Idéation** : les messages d'avancement, de fin, d'arrêt, de délai dépassé et le journal
  écrits par l'application sont traduits, au singulier comme au pluriel.
- **Mode Arena** : « Tout effacer » demande une confirmation avant de supprimer l'historique des
  combats, et les nombres de tokens suivent la langue de l'application.
- **Feuille de route : une fonctionnalité importée d'un service inconnu de l'app garde le nom de ce service** dans son info-bulle, au lieu de « Importé depuis Externe ».
- **Tests générationnels, pour toutes les piles** : une génération ne se créait qu'à partir d'un
  JUnit XML collé à la main, donc rien pour un projet .NET (TRX), Go, Rust, Jest ou Vitest sans
  reporter JUnit, Dart/Flutter ou RSpec. Le panneau lance maintenant la suite du projet lui-même
  (la commande détectée par le Détective de tests instables : dotnet test, pytest, Vitest, Jest,
  Maven, Gradle, go test, cargo test, PHPUnit/Pest, RSpec, dart/flutter test, swift test), ou
  importe un fichier de rapport, ou le lit collé ; le format (JUnit XML, TRX, JSON de Jest/Vitest,
  go test -json, sortie de cargo test, JSON de Dart, JSON de RSpec) est reconnu au contenu. La
  référence se choisit dans la liste, chaque génération montre sa date, sa source et ses
  compteurs, et les erreurs (pas de projet de test .NET, build en échec avec la fin de sa sortie,
  format inconnu) sont traduites. Le hook pre-commit `gen-tests-check` lit aussi le TRX.
- **Revues et commentaires GitHub longs sous Windows** : le texte d'une revue, d'un commentaire, d'une issue créée ou d'un message de merge passe maintenant à `gh` par l'entrée standard (`--body-file -`) plutôt que sur la ligne de commande, que Windows limite à 32 767 caractères et qu'un lanceur `.cmd` coupe au premier saut de ligne.
- **La revue de PR, le tri et l'auto-correction des issues GitHub démarrent à nouveau** : `runners/github/runner.py` s'arrêtait dès son lancement sur `No module named 'services.io_utils'`. L'orchestrateur importe d'autres runners, qui remettent le backend en tête de `sys.path`, si bien que `services` désignait le paquet du backend. Le runner prend désormais `safe_print` dans `core.io_utils`. `check-auto-fix-labels` affiche aussi le numéro, le label et le titre de chaque issue au lieu du dictionnaire brut.
- **Tests du runner GitHub** : 28 tests au total.
  - 13 lancent le runner comme le fait l'application, contre un faux `gh` (`tests/gh_fake.py`, sous Windows, macOS et Linux).
  - 15 testent les commandes qui appellent un modèle, avec un orchestrateur de remplacement.
  - `runner.py` passe de 0 % à 99 % de couverture.
- **Revue IA des merge requests GitLab** : la revue lit enfin la réponse du modèle (elle concluait
  « prête à fusionner », sans aucun constat, quelle que soit la MR), et une réponse sans revue
  lisible ne vaut plus approbation. Un refus de GitLab (jeton, droits, MR introuvable, limite de
  débit) ou une instance injoignable s'affiche en clair au lieu d'une trace Python. L'instance
  auto-hébergée de `GITLAB_INSTANCE_URL` est prise en compte, `--instance` n'est plus écrasé par
  la configuration du projet, et le jeton de glab se lit avec le glab choisi dans l'app. Lancée
  par l'app, la revue reçoit aussi le contexte du code et retient ses constats importants dans
  la mémoire du projet, comme celle de GitHub.
  L'app lance enfin la revue sur le bon projet GitLab : elle passait le dossier local là où le
  runner attend le projet GitLab (`namespace/nom`), qui recevait donc une erreur 404.
- **Clé Google** : la vérification d'une clé Google ou Gemini et l'analyse d'image par Gemini
  envoient la clé dans l'en-tête `x-goog-api-key`, comme le fait déjà le reste de l'app, et non
  plus dans l'adresse.
- **Un seul nom de provider dans l'en-tête** : le sélecteur d'usage nomme le provider observé
  (avec son vrai nom, « Anthropic » au lieu de « anthropic »), et le badge d'authentification à
  côté devient une icône (cadenas pour un abonnement, clé pour une clé d'API) dont l'infobulle
  garde tous les détails.
- **Hermes Agent n'affiche plus « Failed to fetch » au démarrage**. La fenêtre s'ouvre avant le
  backend local : la carte Hermes de la barre latérale l'interrogeait trop tôt et restait en
  « Erreur » jusqu'à un clic sur « Actualiser ». Le main attend désormais la fin du lancement du
  backend avant de répondre aux vues qui l'interrogent (Hermes, commandes slash, catalogue de
  modèles, cerveau…), et un premier démarrage lent (après une mise à jour, sous WSL) n'est plus
  signalé comme un échec au bout de 10 s. Un backend vraiment arrêté est nommé comme tel au lieu
  de « Failed to fetch ».
- **Hooks événementiels** : un hook n'offre plus que les actions qui font réellement quelque
  chose (journal, notification, commande, Slack, Teams, Discord, Google Chat, webhook). Les dix
  actions qui répondaient « exécutée » sans rien faire (lint, tests, génération de tests, agent,
  spec, pipeline, docs, PR, chaînage, personnalisée) sont retirées, avec les neuf modèles bâtis
  sur elles. Un hook déjà enregistré se charge sans ces actions, un nouveau hook qui en nomme une
  est refusé, et un hook dont une action a dépassé son délai est compté en échec.
- **Rapport i18n sur les catalogues de toutes les stacks** : la couverture et les clés
  manquantes par langue se calculent aussi pour .NET (RESX), Android (`strings.xml`), iOS
  (`.strings`), gettext (`.po`), Flutter (ARB), Angular (XLIFF), Java/Kotlin (`.properties`),
  Rails (YAML) et Laravel (`lang/`), et non plus l'i18next JSON seul ; « Analyser tout le
  projet ouvert » lit le projet entier, et le rapport nomme les formats lus. gettext et Laravel
  donnent maintenant le texte traduit et pas seulement la clé, ce qui sert aussi à l'agent i18n.
  L'éditeur reste limité au JSON et le dit.
- **Prompts de l'Incident Responder** : pour un incident CI/CD, le message de commit, la branche, le
  diff, les tests en échec, les erreurs de build et la sortie des tests sont cités comme une
  donnée, comme l'étaient déjà ceux d'un incident de production. Le nom du fichier d'un incident
  proactif est nettoyé avant d'être cité. Chaque champ du modèle de prompt est rempli une seule
  fois : un texte qui nomme un autre champ reste ce texte.
- **Le chat Insights répond sur le provider du projet, et dit quand il ne le peut pas.** Un échec
  chez Copilot, OpenAI ou un autre provider ne relance plus la question sur Claude en silence, et
  une connexion manquante n'est plus remplacée par un texte d'excuse affiché comme une réponse :
  l'app montre la raison. Avec Claude, l'outil en cours s'efface quand il a fini au lieu de rester
  affiché jusqu'à la fin de la réponse.
- **Suivi des dépenses sous Windows** : quand plusieurs tâches écrivaient en même temps dans le registre des dépenses d'un projet, une écriture pouvait passer sans verrou au moment où le précédent était relâché, et échouer (`Access is denied`). Elle attend maintenant son tour.
- **Colonnes du Kanban alignées** : le résumé et la jauge d'« En cours » partagent une même rangée
  sous le titre, et cette rangée reste en place dans une colonne sans résumé. Tous les bandeaux ont
  la même hauteur et les premières cartes s'alignent d'une colonne à l'autre.
- **Colonnes vides du Kanban plus aérées** : le message d'une colonne vide prend toute la largeur
  de la colonne, et les cadres ont tous la même hauteur, si bien que les boutons « Ajouter une
  tâche » s'alignent d'une colonne à l'autre. Le Kanban parle de « tâches » et non plus de
  « cartes », en français comme en anglais.
- **Ajout rapide du Kanban** : « Mettre en file » laisse la carte dans File d'attente, où elle
  attend un emplacement libre, au lieu de la démarrer aussitôt. Un clic ailleurs ferme la boîte
  sans rien perdre : le texte, le type et la priorité reviennent à la prochaine ouverture. La
  croix de fermeture passe dans le coin de la boîte, loin du bouton de création.
- **Gouvernance des licences : des licences enfin résolues, pour toutes les stacks**. Le scan
  ne lisait la licence que dans le manifeste, où elle n'est jamais : chaque dépendance sortait
  « inconnue » et le scan échouait toujours. Il la lit maintenant dans le fichier de
  verrouillage, puis dans le paquet installé (node_modules, venv, cache NuGet, Cargo, Go, Maven,
  pub), puis dans les registres publics (deps.dev, npm, PyPI, Packagist, RubyGems, pub.dev),
  jamais sous une politique hors-ligne stricte. Il lit aussi les projets .NET (`*.csproj`,
  `Directory.Packages.props`, `packages.config`), Java/Kotlin (`pom.xml`, `build.gradle(.kts)`),
  PHP (`composer.lock`), Ruby (`Gemfile.lock`) et Dart/Flutter (`pubspec.lock`). Une licence
  introuvable est rangée « à vérifier », à part des vrais conflits.
- **Licences lues sur les copies installées** : la recherche ne lit que dans le dossier qu'elle
  parcourt (le `node_modules` du projet, ou le cache de paquets de l'écosystème), quel que soit
  le nom de la dépendance ; un `package.json` installé d'une autre forme qu'un objet ne fait plus
  échouer l'analyse.
- **Plus de fenêtre « Unlock Keyring » vide au démarrage sous WSL.** Quand le trousseau est
  verrouillé et que l'app s'en passe pour la session, elle ne lui demande plus rien, donc la
  fenêtre de déverrouillage ne s'ouvre plus.
- **Le démarrage ne reste plus bloqué sur un trousseau Linux verrouillé.** Sous WSL ou en SSH, la
  fenêtre de déverrouillage de GNOME Keyring peut s'afficher vide, et l'app l'attendait sans fin.
  WorkPilot AI ne choisit plus un trousseau verrouillé, et n'attend jamais plus de 5 secondes une
  réponse du trousseau : il démarre sans lui, garde les clés déjà chiffrées telles quelles et la
  bannière dit de déverrouiller le trousseau puis de redémarrer.
- **Le Compagnon en direct fonctionne enfin.** Il surveillait des motifs que chokidar 6 ne comprend plus, donc aucun fichier, et son analyse importait un module absent : aucune suggestion n'arrivait jamais. Il surveille maintenant le dossier du projet pour toutes les stacks (dont .NET/Blazor, Kotlin, Swift, Dart/Flutter, C/C++), analyse le diff ou le début d'un fichier nouveau avec le fournisseur IA sélectionné, garde suggestions et reprises par projet, et affiche pourquoi une analyse a échoué. « Créer une tâche » et « Créer une tâche de reprise » remplacent les boutons qui ne faisaient rien : la correction passe par une carte Kanban (worktree, branche, PR).
- **Longévité et dette technique sur toutes les stacks** : le scanner ne lisait que neuf
  extensions et seuls le `package.json` et le `requirements.txt` de la racine. Il lit maintenant
  Kotlin, Swift, Dart, PHP, Ruby, C/C++, F#, VB, Vue, Svelte, Razor et Elixir, compte les
  fonctions Go, Kotlin et Swift, et relève les dépendances instables ou non épinglées de chaque
  manifeste du dépôt (monorepos compris) : NuGet (`*`, préversions), Maven (`-SNAPSHOT`, plages),
  Gradle (`+`, `latest.release`), Cargo (`*`, git sans `rev`), Go (pseudo-versions), Composer
  (`*`, `dev-`), pub (`any`, git), npm et pip. Le score de longévité et l'analyse de dette
  technique du mode serveur en profitent.
- **A white window reloads itself.** When the window's renderer died (crash, out of memory, GPU
  reset) or its page failed to load, the window stayed white until the app was restarted. It now
  reloads, at most three times a minute, and the log says what took it down (renderer, page load
  or GPU process), so a white window that comes back can be explained.
- **MCP Builder plus robuste** : un fichier de serveurs abîmé ne bloque plus la liste (les
  entrées illisibles sont ignorées), et le Builder garde jusqu'à 200 serveurs.
- **Serveurs MCP de la boucle WorkPilot** : un serveur MCP lancé en commande reçoit la courte
  liste de variables par défaut du SDK MCP (PATH, dossier personnel, utilisateur, terminal),
  plus les variables de son entrée, comme les autres processus enfants de l'app.
- **Marketplace MCP : le module des alertes sur les serveurs installés se charge de nouveau** ; une fusion avait cassé son import.
- **Le merge IA d'un fichier en conflit marche avec chaque provider** : Copilot, OpenAI, Ollama
  ou un modèle local fusionnent le fichier que les deux côtés ont changé, avec leur propre
  modèle ; le jeton Claude n'est plus exigé, et l'erreur affichée est celle du provider.
- **L'aperçu des conflits voit ce que deux tâches ont réécrit** : une fonction modifiée par deux
  tâches est signalée, dans chaque langage reconnu (Python, TypeScript, C#, Java, Go, Rust…),
  à la ligne changée ; la vérification des tâches parallèles avant un merge nomme enfin les
  fichiers qu'une autre tâche non fusionnée a aussi changés.
- **Lecture d'une tâche plus sûre** : un nom de fichier accentué ou un fichier qui n'est pas en
  UTF-8 ne cache plus les autres, et une sauvegarde interrompue garde l'enregistrement précédent.
- Le moteur de merge sémantique que rien n'appelait (pipeline, stratégies, résolveur, frise des
  fichiers) est retiré ; le merge passe par git, puis par le provider de l'utilisateur.
- **Le Contrôle de Mission fait vraiment travailler ses agents** (F183). Un agent lancé n'appelait
  aucun modèle et restait « running » à 0 token ; il répond maintenant avec le fournisseur et le
  modèle choisis (tous ceux qui ont un adaptateur, les CLI dans le projet ouvert), sa réponse
  s'affiche sur la carte avec ses tokens et son coût, et un échec dit pourquoi.
- **App mobile** : l'app se lance de nouveau sur `develop` (deux virgules perdues dans les textes à la fusion du tableau mobile et de la carte « Bloquée ») et la pastille « Bloquée » s'affiche sur la carte du tableau, au lieu d'une ancienne copie de la carte restée dans l'écran.
- **Textes de l'app mobile de nouveau lisibles** : les fichiers de traduction anglais et français de l'app mobile redeviennent du JSON valide (une accolade perdue lors d'une fusion).
- **L'app mobile joint un serveur du réseau local** : l'adresse peut être le nom de la machine
  (`http://build-box`), plus seulement son IP, et l'APK Android accepte enfin le http simple
  vers le réseau local (une version de release le refusait, même vers une IP). iOS reçoit la même
  règle (`NSAllowsLocalNetworking`). Le http reste refusé vers toute adresse publique ou tout nom
  avec domaine.
- **Routage adaptatif des modèles à jour et fidèle au provider** : les modèles proposés viennent
  du registre (Haiku, Sonnet et Opus 5.5, et les modèles actuels d'OpenAI, Gemini, Mistral,
  DeepSeek, Grok, Copilot, Ollama) au lieu d'identifiants périmés. Une tâche ne se voit plus
  suggérer le modèle d'un autre provider : la suggestion reste sur le provider de la phase, et
  un agent CLI qui choisit son modèle n'en reçoit aucun. Copilot et les modèles locaux sont
  présentés sans coût par token, la raison du choix est écrite dans la langue de l'app, et le
  type de tâche se choisit dans une liste.
- **Menu de l'app de nouveau lisible** : deux fusions simultanées avaient laissé les fichiers de
  traduction du menu (anglais et français) sans une accolade, ce qui empêchait l'interface de se
  construire.
- **`pnpm dev` n'affiche plus « npm warn Unknown env config "manage-package-manager-versions" »**.
  pnpm passe ce réglage, qui n'existe que chez lui, à chaque script qu'il lance ; le lanceur du
  frontend démarrait ensuite npm, qui l'avertissait. Le npm du lanceur reçoit désormais un
  environnement sans ce réglage, et `dev:vite` et `build` n'appellent plus npm du tout.
- **Une page qui plante ne vide plus toute la fenêtre** : une erreur d'affichage dans une page
  montre une carte d'erreur à sa place, le menu reste utilisable, et choisir une autre page ou
  « Réessayer » l'efface.
- **Pair programming** : un message envoyé à l'IA pendant la session ne lui parvenait jamais. Le runner l'affichait dans le fil comme « Developer says », vidait le fichier des messages, puis continuait sans le transmettre. L'IA le reçoit maintenant comme le tour suivant, dès que son étape en cours se termine, et le fil dit que le message est arrivé.
- **Pair programming** : les fichiers créés ou modifiés et les commandes lancées sont rapportés quel que soit le provider. Seuls `create_file`, `write_file`, `edit_file`, `str_replace_editor` et `bash` étaient reconnus : avec Claude (`Write`, `Edit`, `Bash`), aucun appel d'outil n'était rapporté, et avec un provider passé par l'exécuteur de WorkPilot, une commande (`run_command`) jamais. Le conflit de périmètre se juge sur les fichiers que l'IA a touchés, et non plus sur un mot de la réponse.
- **Retiré** : le « mode démo » du pair programming, qui annonçait la création de `src/api/auth.py` et de `tests/test_auth.py` sans rien écrire. Une session qui ne peut pas démarrer le dit. Le runner passe à 100 % de couverture (lot B1h).
- **Bureau Pixel : « Logs de l'agent » affiche enfin les logs.** La bulle d'une tâche lit le log de ses phases, en local comme sur un serveur, dès l'ouverture et en direct tant qu'elle reste ouverte ; une tâche terminée montre son log au lieu de rester sur « En attente de logs… », et une tâche sans aucun log le dit.
- **Les cartes ouvertes par une page (studio de tests, Import Design, pair programming…) ont un log.** Chaque exécution y écrit son résumé, ses étapes, les fichiers commités et le message du commit, visibles dans l'onglet Logs et le Bureau Pixel.
- **Le titre d'une carte du studio de tests nomme le fichier testé** (« Tests générés : order_service.py ») au lieu d'un chemin absolu coupé avant le nom du fichier quand un dossier contient une espace.
- **Bureau Pixel : plus de bouton « Arrêter » sur une tâche terminée** qui attend sa revue ; le titre complet s'affiche au survol. Fermer la bulle ne coupe plus le suivi des logs du panneau de la tâche resté ouvert.
- **Une courte suite de tests compte aussi dans l'historique de placement sous Windows.** La durée
  mesurée d'une session se lit désormais sur l'horloge haute résolution : avec l'horloge
  monotone de Python 3.12, qui n'avance que toutes les ~15 ms sous Windows, une session courte
  durait 0 s et n'était jamais enregistrée.
- **Placement de la suite de tests** : le ticket de file d'attente est libéré par un bloc `finally`, sans attraper toutes les exceptions ; la porte de qualité de develop repasse au vert.
- **Créateur de plugins** : l'identifiant d'un nouveau plugin est revérifié par l'application avant que son dossier soit créé (minuscules, chiffres et tirets simples, 64 caractères au plus).
- **Choix de fichiers** : la fenêtre de sélection de fichiers ne reprend de la demande que des options bien formées (titre, dossier de départ, filtres d'extensions).
- **`pnpm run dev` ne bute plus sur un port 9000 tenu par un autre programme.** Le backend et l'app
  passent ensemble au port libre suivant (9001 à 9020) et le disent ; l'app packagée fait de même.
  `BACKEND_PORT` dans `.env-files/.env` fixe un port, utilisé tel quel. Sous WSL en réseau
  `mirrored`, le message cite aussi les connexions mortes que la redirection de ports de VS Code
  laisse sur le port.
- **Plus d'avertissement « Unsupported platform » pour `@lydell/node-pty-darwin-arm64`** à
  l'installation sous Linux et Windows : la dépendance est optionnelle, installée sur macOS arm64
  seulement.
- **Un jeton Claude expiré demande la reconnexion dès le lancement d'un agent**, au lieu
  d'attendre le 401 de la tâche (fenêtre « Authentification requise », sauf si la bascule
  automatique de compte sur échec d'authentification est active).
- **Détails d'une PR** : la demande de détails n'est envoyée que pour un numéro de PR bien formé, et un fichier supprimé par une PR Azure DevOps s'affiche comme supprimé au lieu de renommé.
- **Mémoire d'un projet serveur** : l'onglet Mémoires ne lit le cerveau du projet que s'il est
  bien dans le dossier du projet sur le serveur, et le compteur local des historiques consultés
  n'est plus synchronisé avec le cerveau.
- **REA trouve le Node.js de nvm, fnm, Volta, mise ou asdf**. Quand le Node.js du PATH est trop
  ancien ou absent, WorkPilot prend la version la plus récente qu'un gestionnaire de versions a déjà
  installée et que REA accepte, préversions comprises (27.0.0-alpha). Sous WSL, l'app héritait de
  l'alias par défaut de nvm (26.10.0) alors que le terminal était passé en 27 : le panneau REA
  disait « Node.js trop ancien ». Le bouton d'installation passe alors par le npm de ce Node.js.
- **Le lien « Voir la documentation de REA » s'ouvre sous WSL**. Les liens web passent d'abord par
  Windows quand l'app tourne sous WSL, où ni `xdg-open` ni `wslview` ne sont installés ; un lien qui
  ne s'ouvre toujours pas le dit sous le bouton au lieu de ne rien faire.
- **La commande rapide du Kanban, le catalogue de modèles, le plan d'effort, les capacités agentiques, la recherche dans la bibliothèque Ollama et les outils d'agent (brain, docintel, hermes, vérification, rtk…) joignent enfin le backend local.** Ils appelaient une adresse vide : en développement, la page de Vite répondait à la place du backend, et dans l'app installée la requête était refusée. C'est maintenant le processus principal qui interroge le backend, sur une liste fermée de routes, et les captures, la vidéo et la trace du vérificateur s'affichent et se téléchargent par le même chemin.
- **Un titre de tâche dont l'enregistrement échoue reste ouvert à la correction.** Le champ, encore désactivé au moment de l'échec, recevait un blur qui relançait l'enregistrement tout seul et refermait le champ ; le focus et le nouvel essai attendent maintenant que le champ soit réactivé.
- **L'Agent de Replay et l'Historique des sessions joignent le backend local**, en développement comme dans l'application installée : ils passaient par une adresse vide côté interface et tombaient sur la page du serveur Vite, d'où « Le backend local de WorkPilot n'a pas répondu ». Le Time travel visait aussi un port où rien n'écoute (8321).
- **Chaque session d'agent est enregistrée pour le Replay, quel que soit le fournisseur** : le planificateur et le codeur (Claude compris) n'enregistraient rien, et l'enregistrement du chemin Claude direct s'arrêtait dès son démarrage.
- **Le Débogueur d'agent liste chaque exécution dès qu'elle démarre** et ses points d'arrêt mettent aussi en pause OpenAI, Copilot, Windsurf, Gemini, Mistral, Ollama et les autres fournisseurs dont WorkPilot exécute les outils (les agents en CLI, Codex, OpenCode, pi, Antigravity, exécutent les leurs et restent hors de portée).
- **Feuille de route : un enregistrement qui n'aboutit pas est signalé** au lieu d'un simple rechargement silencieux.
- **Terminal : une recréation dont chaque tentative échoue finit par afficher l'erreur** ; le compteur de tentatives n'est plus remis à zéro à chaque essai.
- **Dette technique : la réponse tardive d'une ancienne analyse n'écrase plus l'écran** d'un projet rouvert ou vidé entre-temps.
- **La roadmap affiche ce que font ses agents, et une régénération en produit vraiment une
  nouvelle.** Le texte et les outils des agents de découverte, de fonctionnalités et d'analyse
  concurrentielle n'apparaissaient jamais dans le journal. Avec « Régénérer la Roadmap », un agent qui n'écrit
  rien n'est plus pris pour l'auteur de l'ancien fichier : la phase réessaie, puis échoue, au lieu
  de garder l'ancienne roadmap en silence. Un fichier d'agent illisible ou mal formé est réessayé
  au lieu d'arrêter la génération.
- **Messages d'erreur sans guillemets** : quand l'analyse échoue, Dérive de la documentation,
  Notebooks, i18n (analyse et traduction), API Watcher, Arbitre de consensus, Garde
  anti-injection, Onboarding (visite et statut), Regression Guardian et Conformité affichent le
  message tel quel, et non plus `"Project path does not exist: …"` entre guillemets avec ses
  `\n` ; un message sur plusieurs lignes garde ses retours à la ligne.
- **MicroVM Docker sous Windows.** Le worktree d'une tâche est monté comme sbx l'exige (sans
  cible, à `/c/…` dans la VM) : la microVM se crée sous Windows 11 et git y voit le dépôt. Une
  commande qui lit son entrée la reçoit, les autres ne bloquent plus sbx.
- **Pièces jointes et design system** : un fichier dont l'analyse n'a pas pu aboutir est mis de
  côté au lieu d'être repris dans le prompt, comme l'est déjà un fichier dont la recherche de
  secrets n'a pas pu se faire.
- **Mode serveur, revue des cartes** : après un build sur le serveur, une carte reste approuvée.
  Le build écrit sa progression dans le plan, que l'approbation couvre : elle tombait à chaque
  build, si bien qu'une relance, une reprise ou le build relancé par « Demander des changements »
  s'arrêtait sur « revue requise », et le téléphone proposait d'approuver la spec à nouveau au lieu
  de fusionner, d'ouvrir la PR ou de renvoyer le travail. Renvoyer le travail compte désormais
  comme l'approbation, par son auteur, du build qu'il relance. Les tests de bout en bout du
  téléphone suivent une carte de la spec à la revue, puis renvoyée en correction.
- **Mode serveur, en direct** : l'app de bureau et l'app mobile rejoignent de nouveau le flux en
  direct d'un projet du serveur. Le serveur refusait le canal tel que les apps l'écrivent dans
  l'adresse (`project%3A…`) : la présence et le chat d'équipe restaient sur « Reconnexion… » et le
  tableau ne suivait que par relecture périodique.
- **Mode serveur, analyses** : la dette technique, la dérive de la documentation, l'accessibilité,
  l'i18n et les tests instables d'un projet du serveur se lancent de nouveau depuis l'app de bureau,
  et leur dernier rapport partagé s'affiche ; le contrôle des dossiers refusait le dossier miroir
  du projet (« TypeError: Cannot read properties of undefined »).
- **Invitations** : un administrateur d'organisation ne se voit plus proposer le rôle
  « Administrateur », que le serveur lui refuse ; seul un administrateur de la plateforme invite un
  « Administrateur du serveur ».
- **Dérive de la documentation** : une fonction citée sous la forme `nom()` ou `nom(arguments)`
  est vérifiée, et plus seulement `nom(`.
- **Mode serveur, GitHub et GitLab** : un projet du serveur hébergé sur GitHub ou GitLab affiche
  de nouveau ses vues « GitHub issues » et « GitHub PRs » (ou « GitLab issues » et « GitLab MRs »)
  dans le menu de l'app de bureau ; le filtre du menu ignorait la forge du projet et les cachait
  toujours.
- **Mode serveur, plusieurs projets** : une personne membre de plusieurs projets du serveur les
  ouvre tous depuis l'app de bureau. Le bouton « + » des onglets liste les projets de l'équipe pas
  encore ouverts ; seul le premier s'ouvrait jusqu'ici.
- **GitHub PRs** : rouvrir la vue relit la liste des pull requests, comme elle le promettait ;
  après l'ajout d'un jeton GitHub, la vue n'affichait plus « GitHub non connecté ».
- **Les issues GitHub d'un projet du serveur s'ouvrent de nouveau** : le test de connexion compte
  les issues ouvertes par une recherche que le serveur refusait, et la vue disait « GitHub non
  connecté ». Le serveur relaie cette seule recherche, écrite par lui pour le dépôt du projet.
- **Se connecter à un serveur après avoir choisi le mode local** : choisir « Mode local » au
  premier lancement était définitif, faute d'écran pour revenir à la connexion. Paramètres →
  Serveur d'équipe propose maintenant « Se connecter à un serveur », qui rouvre l'écran de
  connexion (mot de passe, invitation, Microsoft, SSO).
- **Mode multi-utilisateur, administration** : dans une organisation qu'un administrateur de la
  plateforme vient de créer, changer le rôle d'un membre n'est plus refusé (« l'organisation
  resterait sans administrateur ») tant que ce membre n'en était pas un. Une invitation peut
  nommer le rôle de la personne dans l'organisation (Relecteur, Mainteneur…), et
  **Administration → Membres** ajoute à l'organisation un compte qui existe déjà sur le
  serveur, par son adresse (administrateur de la plateforme), là où une invitation refusait
  l'adresse. Le test de bout en bout du serveur à deux organisations repasse au vert.
- **Mode serveur sous Windows** : supprimer un projet supprime de nouveau son clone ; les objets
  git, en lecture seule sous Windows, le laissaient entier sur le disque sans rien dire.
- **Quotas du serveur** : vider une limite dans l'administration la lève vraiment (elle restait en place), et une limite négative est refusée.
- **Mode serveur : un administrateur d'organisation ouvre les projets qu'on lui liste.** Il
  recevait « Not a member of this project » en ouvrant un projet de son organisation dont il n'est
  pas membre, sa liste de membres ou ses specs, alors que la liste des projets le donnait
  propriétaire. Il y est désormais propriétaire partout.
- **Mode serveur : un job de feature terminé n'est plus noté « échoué » si un coéquipier ouvre
  la feature au même instant.** Le job cessait d'être suivi avant que son résultat soit
  enregistré ; une lecture tombée entre les deux le prenait pour un job abandonné par un serveur
  arrêté.
- **Liens du bas du menu alignés** : « pages masquées », « Réinitialiser la disposition » et
  « Afficher les vues en bêta » sont alignés à gauche sur les pages du menu, chacun avec son
  icône, sous un trait qui les sépare des pages.
- **Instantanés de tâche** : une modification faite dans la même seconde que la précédente, sans
  changer la taille du fichier, entre bien dans l'instantané pris avant une session ou un retour
  arrière ; annuler un retour arrière remet donc toujours le dernier état.
- **Revue des specs** : une spec n'est approuvée que par sa revue (le point de contrôle, la carte
  ou la route serveur). Une approbation qui ne dit pas quel contenu elle couvre demande une
  nouvelle revue.
- **Un build bloqué faute d'approbation indique une commande qui existe.** Le message renvoyait
  vers `review.py`, qui n'existe plus : il propose maintenant la revue de la tâche dans l'app, ou
  `runners/spec_runner.py --continue <spec>` pour la faire dans le terminal. Lancé depuis le backend
  de WorkPilot, le runner de spec trouve le dépôt autour au lieu d'écrire la spec dans le backend ;
  un fichier de tâche illisible est signalé au lieu de planter, et `--provider Anthropic` prend le
  même modèle que `anthropic`.
- **Extraits de fichiers du codeur** : les fichiers qu'une sous-tâche cite et que le prompt du
  codeur reprend passent par les mêmes règles de lecture que le reste du projet (fichiers texte
  du projet, de taille bornée), et sont cités comme des données.
- **Cache de documentation des bibliothèques** : seules les pages rangées dans le dossier du
  cache sont servies ; une entrée d'index qui désigne un autre fichier est ignorée.
- **Essaim** : sur Windows, l'erreur d'une sous-tâche en échec garde des fins de ligne uniformes
  (la fin de sa sortie d'erreur ne mélange plus `\r\n` et `\n`), ce qui remet au vert le test de
  la vague sur la CI Windows.
- **Le Mode Essaim construit vraiment les sous-tâches en parallèle.** Son réglage est désormais
  enregistré et transmis à chaque build : les sous-tâches que le plan permet de mener côte à côte
  tournent en même temps, chacune dans son propre worktree, et sont fusionnées dans la branche de
  la tâche après chaque vague ; une sous-tâche en conflit revient au codeur de la tâche. Les
  options « fusion assistée par IA » et « simulation », que rien n'appliquait, sont retirées.
- **Les autres listes du détail de tâche suivent aussi le thème.** La raison et la tâche liée d'un
  abandon, la branche source de la synchronisation, le destinataire d'un message de pilotage et
  l'appareil de l'aperçu mobile s'ouvrent avec le sélecteur de l'app au lieu de la liste blanche
  du système.
- **Le menu du type de tâche suit le thème de l'app.** Dans le détail d'une tâche, la liste
  (Fonctionnalité, Correction de bug…) s'ouvrait en liste blanche du système, quel que soit le
  thème ; elle s'ouvre désormais avec le sélecteur de l'app, dans les 7 thèmes, en clair comme en
  sombre.
- **Worktree d'un terminal** : la branche de départ lue dans les réglages du projet ou dans son
  `.workpilot/.env` n'est retenue que si c'est un nom de branche valide, comme celle choisie dans
  la boîte de dialogue ; sinon le worktree part de la branche par défaut détectée.
- **Les réglages « Général » d'un projet sont rangés par étape.** Après le dépôt et l'agent, ils
  suivent l'ordre où une tâche se construit : « Avant le code » (découpage, tests d'intégration
  d'abord), « Pendant le code » (TDD), « Avant la revue » (boucle de vérification, où tournent les
  longues suites de tests, revue croisée), puis l'environnement du worktree et les notifications.
  Le réglage des longues suites s'explique en mots plus simples.
- **Erreur d'une sous-tâche du swarm identique sur chaque OS** : la fin de la sortie d'erreur
  d'une sous-tâche qui échoue se lit avec des fins de ligne `\n`, Windows compris, au lieu de
  garder des `\r\n`.
- **Swarm : une sous-tâche annulée dit qu'elle a été arrêtée** : annulée seule puis avec toute
  la vague, elle n'est plus tuée deux fois, ce qui faisait lire sur macOS un code de sortie 255
  au lieu de l'arrêt.
- **La vérification des apps Windows démarre sur une machine froide**. L'assistant UI Automation
  dit qu'il démarre avant que PowerShell ne lise son code C#, et le premier signe de vie a 120 s
  au lieu de 60 : sur une machine Windows chargée, il n'était parfois pas arrivé à temps, et la
  vérification s'arrêtait sur « the UI Automation helper did not start ».
- **Installation du backend rétablie sur un clone neuf** : un lien symbolique `apps/backend/.venv` vers un dossier d'une machine de développement était entré dans le dépôt ; sur tout autre poste c'était un lien mort à l'endroit où `pnpm run install:all` crée l'environnement Python. Il est retiré, `.venv` est ignoré même sous forme de lien, et un test refuse tout lien suivi qui sort du dépôt.
- **Provider inconnu traduit dans l'en-tête** : quand le sélecteur d'usage observe un provider
  inconnu, il affiche « Inconnu » en français au lieu de l'anglais « Unknown ».
- **La vérification de l'app après une tâche ne se trompe plus de verdict** : le rejeu après la QA voit désormais un changement hors de git ou dans un fichier non suivi, le vérificateur reçoit de nouveau les règles du projet, une erreur de console d'une page déjà corrigée ne la fait plus échouer (moteur Playwright), et les problèmes de la fenêtre Windows restent dans le rapport quand aucun navigateur n'est disponible.
- **Scripts PowerShell** : la preuve visuelle (capture de la fenêtre, pilotage UI Automation, lancement de l'application de bureau) et l'émulateur d'app (.NET Framework) citent leurs valeurs par une seule fonction, `shared/utils/powershell-quote.ts`.
- **Preuve visuelle, navigation web** : une étape du plan de navigation reste sur l'application montrée ; une autre adresse est ignorée et journalisée, et la capture montre la page déjà atteinte.
- **Preuve visuelle, tests de bout en bout** : un vrai serveur HTTP, de vrais DOM, un vrai dépôt git avec son remote ; seuls PowerShell, `gh`, MSBuild, l'application de bureau et la capture de fenêtre sont simulés. Le lancement élevé sous Windows ne prépare plus de liste d'arguments, qu'il ne reçoit jamais.
- **Relevés d'usage sous Windows** : quand plusieurs tâches écrivent le même relevé (coûts, tableau
  de bord, carbone), une écriture que Windows refuse un instant, parce qu'un autre programme tient
  encore le fichier, est retentée au lieu d'être perdue.
- **Historique des tests générationnels** : deux captures faites dans la même milliseconde restent
  rangées de la plus récente à la plus ancienne.
- **Mise à jour de la documentation à la release sous Windows** : le CLI Claude installé par npm est
  trouvé et lancé.
- **Contexte cognitif sous Windows** : les fichiers choisis pour une tâche sont nommés `src/a.cs`
  sur tous les systèmes, et non plus `src\a.cs` sous Windows, dans le contexte donné au codeur
  comme dans la vue.
- **API Watcher** : un fichier donné à la place du dossier du projet est signalé par le même
  message sur tous les systèmes (« Not a directory »).
- **Fournisseurs** : la détection du jeton Windsurf garde la clé côté processus principal.
  L'écran SSO affiche la clé masquée et le compte détecté ; « Enregistrer et connecter »
  fait enregistrer la clé par l'application, et dit quand l'enregistrement échoue. Coller une
  clé dans l'onglet Clé API fonctionne comme avant.
- **La préparation du worktree trouve chaque projet d'un monorepo.** Sans `.workpilot/worktree.toml`,
  WorkPilot lit maintenant la racine et les dossiers jusqu'à trois niveaux : un front dans
  `apps/web` et une API dans `src/Api` reçoivent chacun leur commande, lancée depuis la racine avec
  l'option de leur outil (`npm --prefix`, `pnpm --dir`, `dotnet restore src/App.sln`…). Les membres
  d'un workspace n'ont pas de commande à eux. Une solution .NET rangée dans un sous-dossier est
  nommée, au lieu d'un `dotnet restore` qui s'arrêtait faute de projet à la racine. Nouvelles
  stacks détectées : Gradle sans wrapper, sbt, Elixir, Swift, Deno, vcpkg, Conan, F# et VB.NET.

### 🔒 Sécurité

- **Notes du cerveau d'équipe vérifiées par la signature git** (#352). Un projet peut lister ses
  signataires de confiance (onglet Cycle de vie : clés SSH ou GPG déjà utilisées pour signer les
  commits). Une note reçue d'un coéquipier dont le dernier commit n'est signé par aucune de ces
  clés reste lisible, marquée « non vérifiée », mais n'entre plus dans les prompts des agents ni
  dans un arbitrage automatique ; une note écrite ici et pas encore synchronisée reste la vôtre.
  Sans liste, rien ne change.
- **Context Mesh** : ce qui est lu des projets enregistrés (dépendances, dossiers, patterns
  appris) et les connaissances déjà produites entrent dans le prompt nettoyées et délimitées comme
  une donnée, comme tout contenu externe.
- **Streaming** : le jeton d'une connexion d'agent n'apparaît plus dans les journaux de débogage, et un enregistrement de session masque les secrets (clés, jetons) avant d'être écrit sur le disque.
- **API locale** : le backend local ne répond qu'aux requêtes adressées à cette machine (`127.0.0.1`, `localhost`, `::1`, ou l'hôte d'une origine ajoutée par `WORKPILOT_EXTRA_CORS_ORIGINS`) ; les autres reçoivent 421. Le mode serveur n'est pas concerné.
- **Git en langage naturel** : la commande proposée par le modèle ne s'exécute que si elle reste dans une liste fermée de sous-commandes Git, sans option globale, sans option qui lance un autre programme ou écrit hors du dépôt, et vers un remote que le dépôt connaît déjà ; le statut et la branche lus dans le dépôt arrivent au modèle comme des données. Voir l'avis de sécurité publié avec cette version.
- **L'app packagée verrouille ses fuses Electron, et chaque release est auditée avant d'être
  publiée**. `ELECTRON_RUN_AS_NODE` ne fait plus de WorkPilot un Node.js ordinaire, `--inspect`
  n'ouvre plus de débogueur, le code ne se charge que depuis `app.asar` et son intégrité est
  vérifiée sur macOS et Windows. Chaque job de release lance ensuite l'audit statique de REA
  (`rea-agents`, version figée) sur l'app packagée et s'arrête sur une exposition de sévérité
  haute : source maps livrées avec leurs sources, fuse ouvert, marqueur d'identifiant.
- **Mode serveur : contrôles d'accès renforcés** sur les routes de projet et sur l'administration
  des comptes.

### 🛠️ Qualité

- **Nettoyage du texte reçu et lecture des portées de mémoire réécrits plus simplement** : un seul motif retire commentaires HTML, blocs `<script>` et `<style>` à chaque passe, et une portée `team:` / `branch:` se lit sans expression régulière. Le comportement ne change pas.
- **Toute PR verte vers `develop` est fusionnée seule** : le pilote de pile inscrit désormais d'office chaque PR non brouillon de ce dépôt vers `develop` (squash par défaut, dans l'ordre de sa pile), sans label ni auto-merge à poser. Celles de Dependabot comprises ; les PR vers `main`, les brouillons et les forks restent dehors, et le label `autopilot/off` retire une PR.
- **Comparaison de builds : chaque indicateur d'un groupe compte ses propres projets** : la
  médiane d'un groupe pour la durée, le coût, les itérations de QA ou les agents n'est donnée que
  si le nombre minimal de projets du groupe a cet indicateur.
- **Chat d'équipe et pair programming : le texte cité au modèle est nettoyé comme côté
  backend** : commentaires HTML, blocs `<script>`/`<style>` et caractères invisibles retirés, nom
  de fichier et d'auteur gardés sur une ligne (`main/security/untrusted-text.ts`).
- **Chaque changement couvert à 100 %** : sur une PR, la CI vérifie que chaque ligne ajoutée ou modifiée du backend, du frontend et de l'app mobile est lancée par un test, et que chaque branche qui y commence est prise (`scripts/diff_coverage.py`, sans dépendance). Les planchers de couverture restent pour l'ensemble.
- **Connexion Microsoft Entra ID du mode serveur dans un module à elle** : le parcours PKCE de
  l'app de bureau quitte le fichier des handlers pour `main/entra-sign-in.ts`, testé de bout en
  bout contre une redirection locale. Il vérifie la forme des identifiants du serveur avant de
  construire l'adresse de connexion, envoie un `nonce` que le jeton rendu doit reprendre, et
  ouvre le navigateur par `openExternalUrl`, comme les autres liens de l'app.
- **Connexion GitHub par `gh` et création de dépôt alignées sur les autres réglages** : le jeton
  de `gh` s'affiche comme défini, comme les autres jetons du projet, et c'est le main qui
  l'enregistre quand on valide la connexion. Le nom, le propriétaire, la visibilité et la
  description d'un nouveau dépôt sont vérifiés avant toute commande ; `gh` et `git` sont lancés
  par leur chemin, sans shell, et la page de connexion s'ouvre par `openExternalUrl`. Un appel
  inutile à `git branch --show-current` et deux fichiers de test vides sont retirés ; les
  handlers de connexion sont couverts à 100 %.
- **Le train de release lit la réponse du fournisseur de feature flags telle qu'elle arrive** :
  une redirection est gardée comme réponse au lieu d'être suivie, comme le fait déjà la
  surveillance après déploiement. Testé contre des serveurs HTTP locaux.
- **`pnpm dev` et `pnpm build` n'affichent plus les trois avertissements
  `INEFFECTIVE_DYNAMIC_IMPORT`**. `python-runner-env`, `ensure-python` et les handlers CI/CD
  étaient importés dynamiquement par la mesure carbone, la source d'incidents et la veille des PR
  fusionnées, alors que d'autres fichiers les importaient déjà normalement : l'import dynamique ne
  servait à rien. Ils sont importés normalement, et la build refuse désormais tout nouvel import
  dynamique de ce genre.
- **La build du renderer n'avertit plus que `node:fs` et `node:path` sont « externalisés »**.
  `settings/multiconnector/utils.ts` gardait une fonction jamais appelée qui écrivait un fichier
  avec `fs`, ce qui ne peut pas marcher dans la page sandboxée ; elle est retirée, et un test
  refuse désormais tout import d'un module natif de Node dans le renderer.
- **Texte externe nettoyé jusqu'à stabilité** : le nettoyage d'un texte venu de l'extérieur
  (frontend et backend) se répète tant qu'il retire quelque chose, et retire les caractères
  invisibles en premier.
- **La vérification lance toujours la commande détectée** (ou la recette apprise) du projet : l'outil de lancement ne prend plus de commande en paramètre.

### 🧪 Filets de test

- **Le test de la boîte d'abandon du tableau choisit dans le sélecteur de l'app**, qui a remplacé
  la liste native : develop repasse au vert.
- **Le test des règles d'architecture déduites ne lance plus de vraie revue IA** : il passait
  seul mais, après un test qui importe `core`, démarrait la CLI Claude et échouait dans la suite
  complète. La revue y est remplacée par un double, et le test vérifie qu'elle est bien demandée.
- **Couverture backend, lot B2 (agents)** : le paquet `agents/` passe de 72 % à 94 % sur les tests qui le touchent, avec des modèles remplacés seulement à la frontière (fabrique de clients, session) et de vrais fichiers, dépôts git et sous-processus partout ailleurs.
  - À 100 % : le remplisseur de modèle de PR, l'exécuteur de vagues et l'analyseur de dépendances du swarm, l'analyse d'impact, le débogueur persistant et sa porte pour les providers hors SDK, le marqueur de hot swap, le parseur de reprise après rate limit, les outils WorkPilot de mémoire et de progression, les helpers git et de synchronisation de spec, l'enregistrement des sessions pour Replay et Debugger.
  - Plus couverts : la boucle de session SDK (52 → 84 %), le coder (70 → 86 %), le planificateur de suivi, la mémoire de session dans le vault, le documenteur et le refactoreur (99 %), le câblage optionnel (routeur de modèles, contexte cognitif, agents de domaine).
  - Code mort retiré, preuves à l'appui : le registre du débogueur en mémoire, les replis `ImportError` vers des paquets qui sont toujours livrés, l'alias `sync_plan_to_source`, `SwarmConfig.from_dict`, `SubtaskNode.all_files` et des `except` qui ne pouvaient pas se déclencher.
- 🐛 **Un sous-agent du swarm ne tient plus la vague au-delà de son délai** : le délai couvrait la lecture de la sortie mais pas la fin du processus. Une ligne de sortie de plus de 64 Ko ne fait plus échouer la sous-tâche (« Separator is not found »).
- 🐛 **Le swarm respecte son nombre de nouvelles tentatives**, et une sous-tâche réussie au second essai compte comme réussie : la vague est fusionnée avec elle au lieu d'être déclarée en échec.
- 🐛 **Un plan dont toutes les sous-tâches sont déjà faites termine le swarm** au lieu d'échouer sur une `KeyError` dans ses statistiques.
- 🐛 **Le coder répond à l'agent qui demande s'il doit bloquer une vérification manuelle** : la question était cherchée avec une majuscule dans sa réponse mise en minuscules, donc jamais trouvée.
- **Couverture backend, lot B4b (analyse de projet)** : l'index du projet (langages, frameworks, ports, routes, modèles de données, variables d'environnement, services, authentification, migrations, tâches de fond, monitoring), la découverte de la CI et des tests, le rayon d'impact d'un changement et l'extraction d'enseignements après une session passent de ~55 % à ~99 %, sur de vrais projets écrits sur disque dans chaque pile. Trois modules que plus rien n'appelait sont supprimés (`analysis/security_scanner.py`, `analysis/risk_classifier.py`, la façade `analysis/project_analyzer.py`) ; la QA garde son propre scanner (`security/qa_scanner.py`).
- **Index du projet** : les routes Next.js (App Router et Pages Router) sont enfin trouvées ; une méthode Spring ne prend plus le `@PreAuthorize` de la méthode du dessus, et un `@Secured` de classe protège toutes ses méthodes ; les ports d'un service docker-compose sont lus même après un `image:` ou un `build:` ; les colonnes d'un modèle SQLAlchemy, Django, Prisma ou TypeORM ne se mélangent plus d'une classe à l'autre ; les fichiers d'un `.venv` ou d'un `node_modules` ne comptent plus ; les chemins sont écrits avec des `/` sous Windows aussi.
- **Variables d'environnement** : une URL qui porte un mot de passe est masquée, une variable `export X=` est lue, un `DB_PASSWORD` de docker-compose est marqué sensible, et `os.environ["X"]` rend `X` obligatoire.
- **Documentation d'API** : `swagger-jsdoc` et `@apollo/server` sont nommés tels qu'installés.
- **Découverte de la CI** : les déclencheurs GitHub Actions sont lus (YAML lit la clé `on` comme un booléen), la première commande pytest reste la commande unitaire, et les commandes de test .NET, Java, Ruby, PHP, Swift, Dart et Elixir sont reconnues.
- **Découverte des tests** : un projet .NET, Maven, Gradle, PHP, Swift, Dart, Flutter ou Elixir a sa commande de test (la boucle d'auto-correction de la QA n'en avait aucune), les tests d'une dépendance dans `node_modules` ne comptent plus comme ceux du projet, et un `Gemfile` qui n'est pas en UTF-8 ne fait plus échouer la découverte.
- **Rayon d'impact** : un import est comparé segment par segment (`react` ne dépend plus de `a.py`), `from paquet import module` compte, une cible hors du projet est ignorée, et un projet ouvert par un chemin non résolu ne plante plus.
- **Enseignements de session** : le diff git est lu en UTF-8 (un caractère accentué faisait perdre tout le diff sous Windows).
- **Analyseur** : `analyzer.py --quiet` n'écrit plus rien d'autre que le JSON promis.
- **Tests du merge** : trois fichiers de tests plaçaient `tests/` devant le backend dans `sys.path`, si bien que le dossier `tests/accessibility_agent` masquait le vrai paquet pour les tests collectés après eux ; ils l'ajoutent désormais en fin de chemin.
- **Couverture backend, lot B3c (CLI)** : tout le dossier `cli/` passe à 100 %. Les commandes de workspace tournent sur de vrais dépôts git, `python -m cli.main` est lancé comme le fait l'application, et `handle_build_command` est testé de bout en bout : build bloqué sans approbation, reprise d'un build existant, worktree isolé, QA, pause, découpage, arrêt et plantage.
- **Ctrl+C pendant un build** : reprendre le build après la pause plantait (variable inconnue), et le retour à l'état « en cours » visait un état qui n'existe pas. Les deux sont corrigés.
- **Auto-réparation, mode tableau de bord** : `--dashboard` plantait au lieu d'afficher le tableau ; il sort maintenant en erreur si le tableau ne peut pas s'ouvrir.
- **Budget des coûts** : la vue du budget affichait la dépense totale depuis toujours au lieu de celle de la période.
- **Streaming** : la relecture d'un enregistrement lisait une option que l'analyseur ne définit pas, et `--streaming-port` était ignoré.
- **Lots de tâches** : le statut et le nettoyage reposent sur l'approbation réelle de la QA, plus sur la seule présence d'un rapport (un rapport de rejet comptait comme approuvé) ; le nom du dossier d'une tâche suit le même format que celui du tableau Kanban.
- **Création de PR** : `--create-pr --pr-body-file` sur un fichier illisible plantait (`NameError`) ; sans build trouvé, la commande renvoie maintenant son erreur en JSON comme les autres cas.
- **Code mort retiré** : les ajouts à `sys.path` du dossier parent dans chaque module de `cli/`, `find_specs_dir`, `collect_user_input_interactive`, `cleanup_old_worktrees_command`, `worktree_summary_command`, le repli jamais atteint sur `foundation.debug`, et des branches sans effet dans `handle_build_command`. Plusieurs `except Exception` sont resserrés sur les erreurs réellement possibles.
- **Couverture backend, lot B2a (`core/`)** : la jauge d'usage Copilot (quotas personnels, rapports d'entreprise et d'organisation, droits manquants, `gh` absent ou non connecté, garde des URL de rapport), la session Claude des insights, le fournisseur et le modèle nommés dans les logs, les rapports d'erreur Sentry, les quatre destinations de l'usage d'une session et la lecture du plan par la boucle de build passent à 100 %. Le `gh` des tests est un programme qui répond aux commandes choisies ; la base d'analytics est un vrai fichier SQLite ; Sentry tourne avec le vrai SDK et un transport qui garde ce qu'il aurait envoyé.
- **Rapports d'erreur** : le nom d'utilisateur est masqué dans tout le rapport. Seuls certains champs l'étaient, et les variables locales de chaque frame partaient telles quelles : une erreur levée sur un chemin sous `/home/<nom>/` envoyait ce chemin.
- **Code mort retiré** : `core/optimization` (que rien n'importait), la route d'usage Claude du backend (l'app ne l'appelait pas), les runtimes Copilot et LiteLLM avec `core/llm_client.py` (leur seul appelant demande toujours Claude), le streaming de la session Claude (il échouait au premier message et rien ne l'appelait), `get_plan_summary` et `format_duration`.
- **Copilot détecté dans les logs** : le `gh` est trouvé comme partout ailleurs (réglage de l'app, PATH, dossiers d'installation) ; un `gh` nommé seulement par le réglage de l'app, ou installé en `gh.cmd` sous Windows, n'était pas vu.
- **Couverture backend, lot B2 (worktrees et espace de travail)** : le gestionnaire de worktrees, la création des PR et MR (GitHub, GitLab, Azure DevOps) et l'ajout d'un build au projet sont testés sur de vrais dépôts git, avec un faux `gh` / `glab`, une fausse API Azure DevOps et un modèle qui répond depuis le test. `core/worktree_pr.py` passe de 43 % à 97 %, `core/worktree.py` de 71 % à 95 %, `core/workspace.py` de 36 % à 88 %, `finalization.py` de 13 % à 100 %, `display.py` de 64 % à 100 %, `git_utils.py` de 30 % à 99 %, `workspace_setup.py` de 42 % à 95 % et `models.py` de 44 % à 90 %.
  - Code jamais exécuté retiré : `cleanup_stale_worktrees`, `list_all_spec_branches`, la recherche de branche dans le registre des worktrees (git y écrit « detached » pour un worktree détaché), `create_conflict_file_with_git`, `is_process_running`, deux constantes inutilisées et les replis d'import de `foundation.debug`.
- **Une fusion « préparée sans commit » ne garde plus les fichiers que le projet ignore** : `git check-ignore` ne signale pas un fichier déjà indexé, donc aucun fichier ignoré n'était retiré de l'index après la fusion.
- **Un worktree dont le fichier `.git` est abîmé peut être recréé** : git refusait de le supprimer et la tâche ne pouvait plus jamais avoir de worktree.
- **Un fichier fusionné par l'IA garde son dernier saut de ligne** : la réponse du modèle était tronquée de ses blancs, et chaque fichier fusionné perdait sa fin de ligne.
- **« Ajouter à mon projet » après un build est compté comme une fusion** : ce choix du menu fusionnait sans prévenir les compteurs d'usage, la boucle d'apprentissage ni la mémoire, contrairement aux autres chemins de fusion.
- **Le message de fusion dit ce qui a changé** : il affichait « What changed: » sans rien dessous, car il lisait des statistiques qu'aucune fusion ne produit.
- **La validation de syntaxe d'un fichier fusionné et la création des liens `node_modules` suivent les règles de plateforme** : le fichier temporaire est écrit en UTF-8 (sous Windows, un caractère hors de la page de code locale faisait sauter la validation en silence) et Windows est détecté par `foundation.platform`.
- **La vérification de syntaxe d'un fichier TypeScript ou JavaScript fusionné tourne aussi sous Windows** : elle cherchait un `esbuild` sans extension et appelait `npx` sans `.cmd`, si bien qu'elle était sautée à chaque fusion. Elle lance maintenant le binaire natif d'esbuild, ou son script par Node, ou `npx.cmd`. Sur tous les OS, un Node absent ou un `npx` qui n'a pas pu télécharger esbuild n'est plus pris pour une erreur de syntaxe du fichier.
- **Couverture backend, lot B3a (intégrations)** : tout le dossier `integrations/` passe à 100 %. Le client Windsurf (découverte des identifiants, appel de chat en streaming, flux Cascade) est testé contre un faux serveur de langage local qui parle le vrai protocole Connect ; la mise à jour Linear passe par le port `agent_runtime` avec un client de remplacement ; JEV et les notifications Slack / Teams envoient de vraies requêtes à un serveur local.
- **Notifications Slack / Teams** : une adresse de webhook qui n'est pas une URL (`pas une url`) est refusée comme un schéma interdit. L'envoi levait une exception, alors qu'il ne doit jamais faire échouer l'appelant.
- **Windsurf, mode Cascade** : le message d'erreur renvoyé par le serveur s'affiche sans les espaces qui suivaient sa première ligne.
- **Code mort retiré** : `integrations/windsurf_mcp.py` (une intégration MCP jamais connectée : le test de connexion Windsurf passait toujours par l'API directe), le paquet `integrations/azure_devops/` (aucun appelant ; Azure DevOps passe par `src/connectors/azure_devops`) et le gestionnaire de projet Linear (`LinearManager`, aucun fichier ne créait l'état qu'il lisait). La vérification de l'environnement d'un build n'annonce plus un projet Linear « initialisé pendant la planification » qui ne l'était jamais.
- **Couverture backend, lot B4e (migration de code)** : l'analyse du projet et le plan que lit la page Migration de code passent à 100 %, testés sur de vrais projets. Les transformateurs de code, le transformateur assisté par modèle, le retour arrière, le validateur, le rapport et la ligne de commande `python -m migration`, qu'aucune partie de l'application n'appelait, sont supprimés (environ 6 000 lignes), avec le type d'agent `migration` qui ne servait qu'à eux.
- **Migration de code, analyse du projet** :
  - un projet Python qui ne déclare ses dépendances que dans `pyproject.toml` (uv, Poetry, PDM) est reconnu comme Django, Flask ou FastAPI. Il sortait en « python » générique et aucune migration ne lui était proposée ;
  - `node_modules`, les environnements virtuels, les dossiers de build et les worktrees de `.workpilot/` ne sont plus parcourus. Un projet Python avec une chaîne d'outils front sortait en JavaScript, et l'analyse d'un gros projet prenait plusieurs minutes ;
  - un fichier `.sql` qui n'est pas en UTF-8 n'arrête plus l'analyse, qui faisait afficher la migration comme non prise en charge ;
  - un `tsconfig.json` vide (`{}`) et un Angular installé (`node_modules/@angular/core`) sont reconnus.
- **Couverture backend, lot B4e (QA, boucle et portes)** : la boucle de validation QA (`qa/loop.py`) et chacune des portes qui peuvent renverser une approbation (contrat d'API, dépendances, dérive de la doc, exposition, couverture, preuve, schéma, QA ciblée, WinDev, mutation, API publique .NET, red team), la re-vérification par delta, le rapport QA et les statistiques de la correction automatique passent à 100 %. Les tests suivent chaque façon dont une porte renonce sans bloquer : un fichier qu'elle ne peut pas écrire, un outil absent, un ensemble de changements inconnu. Les statistiques de la correction automatique n'attrapent plus que ce qu'un plan illisible ou modifié à la main peut lever.
- **Couverture backend, lot B4e (QA, sessions)** : le relecteur QA et le correcteur QA suivent leur session par un seul module, `qa/session_stream.py`, à la place des deux copies qu'ils portaient chacun (environ 1 000 lignes, dont la moitié écrite pour un client que plus rien ne crée). Ce module, le relecteur, le correcteur et la boucle de correction automatique passent à 100 %, testés sur un vrai client scripté. Les faux modules du SDK que des tests de la QA laissaient dans `sys.modules` sont retirés.
- **QA, relecteur et correcteur** :
  - une session que le fournisseur termine sur une erreur (limite atteinte, connexion expirée) est rapportée comme telle. Le relecteur disait à la passe suivante qu'elle avait « oublié de mettre à jour le plan », et le correcteur répondait « corrigé » sans avoir rien touché, ce qui faisait dépenser une passe de relecture sur le même code ;
  - la carte Historique des sessions d'une passe QA nomme son fournisseur et son modèle, et une session qui plante y finit en échec.
- **QA, correction automatique (`--auto-fix`)** :
  - les échecs de pytest sont comptés : pytest les écrit avant les réussites (`2 failed, 5 passed`), et la demande de correction en annonçait 0 ;
  - une suite qui écrit dans un autre encodage que l'UTF-8 (console Windows) garde sa sortie, qui était perdue et remplacée par « Test execution failed » ;
  - chaque passe qui a corrigé ou échoué est enregistrée dans la mémoire du projet. L'appel ne correspondait pas à la fonction de mémoire et aucune n'avait jamais été enregistrée ;
  - une limite de débit atteinte pendant la session du correcteur est attendue au lieu de coûter une tentative ;
  - le rapport d'escalade compte toutes les tentatives et montre la sortie de la dernière, les motifs d'échec fréquents remplissent les statistiques, et la sortie des tests recopiée dans la demande de correction est bornée à sa fin.
- **Couverture backend, lot B4a (revue de code)** : le point de revue humaine avant le build (résumé de la spec et du plan, éditeur, avis, approbation), le score de qualité et ses analyseurs (clones, performance, couverture statique, Java, Kotlin, C#, Go, Rust, motifs appris, règles du projet, historique et badges) passent à 100 %, sur de vrais fichiers ; seule la recherche grepai est remplacée.
- **Revue de code** : les clones à l'intérieur d'un même fichier sont détectés (un fichier comparé à lui-même ne rendait jamais rien) ; plusieurs lignes supprimées d'affilée comptent toutes, et chacune porte son numéro dans l'ancien fichier ; l'analyse étendue (Java, Kotlin, C#, Go, Rust) ne plante plus sur chaque fichier et analyse le code au lieu de son chemin.
- **Corrections automatiques** : un fichier corrigé garde ses fins de ligne (un fichier CRLF devenait LF, et inversement sous Windows).
- **Couverture statique** : un projet rangé sous un dossier dont le nom contient « test » n'est plus vu sans aucune source, le dernier nom d'un import est reconnu, et le nombre de fichiers de test est bien celui des fichiers.
- **Règles personnalisées** : `**/*.py` s'applique aussi aux fichiers à la racine du projet.
- **Historique qualité** : la tendance n'est plus inversée (« en progrès » pour un score qui baisse), le rapport d'une revue sans numéro de PR s'enregistre sous Windows (le nom portait des « : »), et l'URL du badge n'est plus coupée par le « / » de « 95/100 ».
- **Point de revue** : l'éditeur se trouve aussi sous Windows (la recherche passait par `which`), `$EDITOR` peut porter des arguments (`code --wait`), une ligne de tableau qui contient le mot « file » n'est plus prise pour l'en-tête, et `[X]` compte comme une case cochée.
- **Performance** : des boucles imbriquées sous un `if` ou un `with` comptent comme imbriquées.
- **Couverture backend, lot B1d (runners)** : six runners de plus passent à 100 %, lancés comme l'application les lance, sur de vrais dépôts git et de vrais dossiers.
  - Instantanés d'environnement : `env_snapshot_runner.py` (capture, liste, relecture, export Dockerfile, Nix et script ; les secrets n'atteignent jamais le fichier).
  - Prédiction de conflits : `conflict_predictor_runner.py` et son service (`services/conflict_predictor_service.py`), sur un dépôt dont les branches touchent les mêmes fichiers.
  - Context Mesh : `context_mesh_runner.py` (inscription des projets, résumé, recommandations, analyse).
  - Learning Loop : `learning_loop_runner.py` (verdicts gardés avec leur historique, versés au cerveau partagé, analyse sans modèle).
  - Swarm : `swarm_runner.py` (vagues de sous-tâches indépendantes, code de sortie selon l'issue).
  - Cerveau partagé : `brain_runner.py` (création, mémorisation, rappel, promotion, synchronisation, import des mémoires d'agents, ponts, MCP, surveillance).
- **La prédiction de conflits ne compte plus le projet lui-même comme une branche à fusionner** : la première ligne de `git worktree list` (le checkout du projet) apparaissait dans les branches actives et dans l'ordre de fusion conseillé. Une branche ouverte dans un autre worktree apparaissait aussi en double, sous le nom `+ branche`.
- **Le plancher de couverture backend passe à 71 %** : la suite complète en couvre 72,0 % (70,6 % avant ce lot).
- **Couverture backend, lot B1e (runners)** : quinze runners de plus passent à 100 %, lancés comme l'application les lance, sur de vrais dépôts git, de vrais projets et de vrais fichiers ; seuls les appels à un modèle sont remplacés par une doublure.
  - Git Surgeon (analyse, plan, application sur une nouvelle branche, branches fusionnées) et Injection Guard (prompts enregistrés dans tous les formats lus).
  - Dette technique, rayon d'impact, index du projet, aperçu de l'app, profilage des performances.
  - Formula Lab : matrice des formules, affinage par le modèle, prédiction de coût.
  - Débogueur d'agent, vérification (`/verify`), Bounty Board, best-of-N.
- **La prédiction de coût trouve de nouveau les specs** : elle ne cherchait que dans l'ancien dossier `.autonomousbuild/specs/` et répondait « Spec not found » pour toute spec de `.workpilot/specs/`. Elle lit les deux, et seulement un dossier de spec du projet.
- **Code mort retiré** : le runner du profilage des performances gardait un repli « module pas encore disponible » que rien ne pouvait atteindre, le module `performance` étant livré avec le backend.
- **Plancher de couverture backend relevé à 72 %** (72,7 % mesurés) : la CI refuse une PR qui ferait redescendre la suite en dessous.
- **Couverture backend, lot B1f (runners)** : Hermes, le serveur MCP UI/UX, le générateur de pipelines CI, le suivi de PR, le Code Playground, l'API Watcher, l'Architecture Visualizer (rendu réel par archify), le mode hors-ligne (serveurs de modèles locaux réels) et Regression Guardian passent à 100 %, lancés comme l'application les lance ; seuls les appels à un modèle et à `gh` sont remplacés par une doublure. Le plancher de couverture du backend en CI passe de 72 à 73 % (73,4 % mesurés).
- **Le générateur de pipelines CI répond de nouveau** : il importait un module de session qui n'existe pas et plantait dès qu'il appelait le modèle. Il passe par la session des agents et lit sa réponse.
- **L'analyse IA de Context Mesh renvoie son résultat** : elle lisait la réponse de la session avec le mauvais nombre de valeurs et rendait toujours une analyse vide.
- **Le Code Playground choisit un modèle encore servi** : sans modèle choisi, il demandait un identifiant Sonnet retiré, écrit en dur. Il prend désormais le Sonnet configuré par l'utilisateur. Une réponse qui ouvre un objet JSON sans le fermer ne fait plus planter le runner : elle devient une page simple, comme toute réponse illisible.
- **L'API Watcher lit un projet ouvert par un lien symbolique** : hors git, un projet atteint par un lien (ou un chemin relatif) répondait « aucune spec n'a pu être lue », car chaque contrat trouvé tombait hors du chemin donné. Une baseline vide ne fait plus échouer le runner sur une erreur sans message.
- **Regression Guardian reconnaît un incident déjà couvert par un test** : le tableau de bord ne donnait aucun dossier de tests au détecteur de doublons, qui ne trouvait donc jamais rien. Il lit maintenant les tests du projet, sans ceux des dépendances, des dossiers de build ni des dossiers cachés. Un incident que l'analyseur refuse est signalé au lieu de disparaître en silence.
- **Couverture backend, lot B1g (runners)** : Design-to-Code, la dictée locale, l'Idéation, le Coach personnel et son profil de style, l'accessibilité, la documentation, le studio de génération de tests, le changelog, la roadmap, la migration de code et l'analyseur IA en ligne de commande passent à 100 %, lancés comme l'application les lance, dans l'environnement UTF-8 qu'elle leur donne. Seuls les appels au modèle sont remplacés ; l'export Figma passe par son client HTTP. Un chemin de fichier proposé par le modèle hors du dossier de sortie reste refusé.
- **Idéation** : une génération dont aucun type n'a produit d'idée est désormais un échec. Elle se terminait en succès, et la page affichait une idéation « terminée » vide.
- **Coach personnel et accessibilité** : un message d'erreur s'affiche sans les guillemets qui l'entouraient, et un enregistrement d'exécution illisible (`"tokensUsed": "beaucoup"`) est ignoré au lieu de faire échouer tout le coaching.
- **Génération de tests, projets Python** : les bibliothèques déclarées dans un `pyproject.toml` (PEP 621, groupes PEP 735, Poetry) ou un `Pipfile` sont reconnues. Le fichier était lu ligne par ligne : `"pytest>=8",` dans une liste n'était jamais vu, et le studio proposait d'ajouter pytest à un projet qui l'avait déjà.
- **Roadmap** : la génération reprend l'index du projet lui-même (`.workpilot/project_index.json`), comme la spécification et l'Idéation. Elle le cherchait à côté des runners du backend, où un index d'un autre projet aurait été copié dans chaque roadmap ; le fichier de ce genre resté dans le dépôt, qui décrivait un projet sans rapport, est supprimé.
- **Couverture backend, lot B1a (runners)** :
  - 13 modules de `runners/github/` qu'aucun code n'importait sont supprimés : `audit`, `cleanup`, `confidence`, `errors`, `learning`, `lifecycle`, `onboarding`, `override`, `purge_strategy`, `storage_metrics`, `testing`, `trust` et `sanitize`, soit 6 600 lignes jamais exécutées.
  - La couverture mesure désormais aussi les runners lancés en sous-processus, comme le fait l'application (`.coveragerc`).
  - Le backend passe de 67,3 % à 69,9 % de couverture, et son plancher de 58 % à 69 %.
- **L'outil `cleanup_pr_worktrees.py` se lance à nouveau comme le dit son usage** : `python cleanup_pr_worktrees.py --list` échouait sur `No module named 'foundation'`, car le chemin du backend n'était ajouté qu'après le chargement du gestionnaire de worktrees.
- **Couverture backend, lot B1c (runners)** : six runners passent à 100 %, chacun testé comme l'application le lance (sous-processus) sur de vrais fichiers, dépôts git ou serveurs HTTP locaux.
  - Auto-réparation : `self_healing_runner.py` (configuration, incidents, CI/CD, production, proactif, tableau de bord).
  - Release train : `release_coordinator_runner.py` (plan, notes, démarrage, reprise, abandon, historique).
  - Notebooks : `notebook_agent_runner.py` (analyse, extraction d'une cellule longue, nettoyage, exécution, chiffres mensuels).
  - Bac à sable : `sandbox_runner.py` (fichiers ajoutés, supprimés, renommés et modifiés, avec leurs hunks).
  - Déclencheurs CI/CD : `cicd_triggers_runner.py` (GitLab et Jenkins contre un serveur local, GitHub Actions et Azure DevOps).
  - Agent navigateur : `browser_agent_runner.py` (références visuelles, comparaison, tableau de bord, échec propre sans Chromium).
  - Le backend passe de 69,9 % à 70,6 % de couverture, et son plancher de 69 % à 70 %.
- **Déclencheurs CI/CD** :
  - le statut et l'annulation d'un run GitHub acceptent l'alias `github_actions`, comme le déclenchement : ils lisaient `CICD_GITHUB_ACTIONS_TOKEN` au lieu de `CICD_GITHUB_TOKEN` ;
  - Jenkins reçoit la branche et l'URL de la PR encodées : un `&` dans l'une d'elles coupait les paramètres du build.
- **Couverture backend, lot B3b (sécurité)** : le scanner de vulnérabilités, les rapports (JSON, Markdown, HTML, SARIF), l'orchestrateur et sa commande, le scan de sécurité de la QA, l'analyse de conformité et les validateurs de commandes ont leurs tests de comportement. Les outils externes (bandit, semgrep, pip-audit, npm audit, snyk, trivy) répondent avec la sortie JSON qu'ils impriment vraiment ; le scan de secrets et les commits tournent dans un vrai dépôt git.
- **Scan de sécurité de la QA** : il ne voyait aucun fichier d'une tâche, parce que son worktree vit sous `.workpilot/`, un dossier qu'il écarte ; seuls les dossiers *dans* le projet sont désormais écartés, et les fichiers `.env` / `.env.local` sont lus.
- **Scanner de vulnérabilités** : le scan de secrets listait les fichiers du dépôt courant au lieu de ceux du projet ; pip-audit auditait l'environnement de WorkPilot au lieu des dépendances du projet, et sa sortie réelle faisait échouer la lecture ; npm audit (format npm 7+) et une erreur d'analyse ESLint faisaient échouer leur scan. L'identifiant d'un secret trouvé est stable d'un scan à l'autre.
- **Rapport HTML de sécurité** : le texte d'un résultat, qui vient du code scanné, s'affiche comme du texte.
- **Commande `python -m security.security_orchestrator`** : un commit n'est plus bloqué par un secret dans un fichier qu'il ne touche pas, la politique compte enfin les secrets, et `block_on_compliance_critical` est respecté.
- **Validateurs de commandes d'agent** : plusieurs validateurs (git, bases de données, archives, processus, suppression de fichiers) lisent désormais chaque forme d'écriture de leurs options et le dépôt que vise la commande ; chaque refus a son test.
- **Code mort retiré** : `security/auto_integration.py`, `git_hooks.py`, `verify_security_feature.py` et `FEATURE_STATUS.json` (aucun appelant ; le dépôt utilise `.husky/`), la moitié inutilisée de `content_sanitizer.py` (validateur de sortie, fonctions de commodité), `validate_tool_input` et `check_tool_available` (aucun appelant), la liste de motifs `rm` que la règle des chemins relatifs couvrait déjà.
- **Couverture backend, lot B3d (fin de `security/`)** : les guardrails (lecture des règles, politique par couches, journal et approbations, analyse des manifestes de dépendances), la garde des résultats d'outils, l'analyseur de commandes et la garde de la configuration de sécurité passent à 100 %. Les cas limites sont testés pour de vrai : fichiers illisibles, disque qui refuse l'écriture, approbation expirée ou impossible à marquer, page énorme échantillonnée, analyseur qui lève une exception.
- **Garde de la configuration de sécurité** : un `bash -c` imbriqué dans un autre est désormais lu comme le lit le shell. Les guillemets du script intérieur étaient coupés, la ligne n'était plus analysable et seule la recherche du nom de fichier s'appliquait. La limite de profondeur des `bash -c` imbriqués s'applique de nouveau.
- **Code mort retiré** : `security/secure_subprocess.py` (aucun appelant), `load_guardrails`, `GuardrailDecision.should_block`, `guardrail_semantics.is_manifest` (la garde des dépendances a la sienne) et deux branches inaccessibles de l'analyseur de commandes.
- **Couverture backend, lot B4c (création de spec)** : l'orchestrateur, chaque phase, l'exécuteur d'agents, la compaction, les validateurs, la réparation automatique du plan et sa récupération passent de ~56 % à ~97 %, testés de bout en bout sur un vrai dossier de spec. Code mort supprimé : les façades `spec/phases.py` et `spec/pipeline.py`, le paquet `spec/templates/` et `apply_template_to_requirements` que rien n'appelait, et `spec/validate_spec.py`, qui plantait au lancement.
- **Dossier de spec renommé** : quand un dossier `NNN-pending` prend le nom de la tâche, l'orchestrateur, le validateur, l'exécuteur d'agents et le journal de la tâche suivent le nouveau dossier ; le journal restait dans l'ancien, qui n'était jamais nettoyé.
- **Fournisseurs** : le résumé d'une phase passe par le client du fournisseur choisi (il exigeait le jeton Claude) ; une limite de débit ou un prompt trop long est reconnu sur tous les fournisseurs, pas seulement sur le SDK Claude ; le fournisseur actif est lu sans consommer le marqueur de reprise.
- **Toutes les piles** : la spec et le contexte de secours ne supposent plus un service Python sur le port 8000 et ne nomment plus de fichiers inventés ; les fichiers cités dans la tâche sont repris quelle que soit leur langue ; l'analyseur du projet est lancé en UTF-8 (Windows).
- **Plan** : un plan qui est une liste JSON ne fait plus planter la spec ; le validateur signale une phase, une sous-tâche ou une vérification qui n'est pas un objet au lieu de lever une exception ; la réparation d'une virgule en trop ne perd plus le plan et ne remplace plus un nombre final par 0 ; le plan de secours a un nom de feature et passe la validation ; les conseils de correction ne citent plus d'anciennes commandes.
- **Éditeur** : `EDITOR`, puis `VISUAL`, puis le premier éditeur installé (notepad sous Windows, nano, vim ou vi ailleurs) ; sans éditeur, ou si l'éditeur supprime son fichier, la saisie revient vide au lieu d'échouer.
- **Couverture backend, lot B2e** : l'exécuteur d'outils, par lequel passent les lectures, écritures, recherches et commandes de tous les providers autres que le SDK Claude, passe à 100 %. Chaque outil est appelé sur un vrai projet comme le fait un client (chemin hors du projet, fichier binaire, dossier à la place d'un fichier, fichier lié hors du projet, plan vide), les commandes sont de vrais processus (sortie sur les deux flux, code 1 sans sortie, arrêt de l'arbre de processus, `taskkill` sous Windows), et le bac à sable de l'OS est remplacé par un double qui lance la commande et nomme les hôtes refusés.
- **Exécuteur d'outils** : l'OS se lit par `foundation.platform` et non plus par `os.name`, les erreurs de lecture et d'écriture attrapées sont celles du disque, et huit gardes autour de modules du backend qui ne peuvent pas échouer à l'import sont retirées.
- **Couverture backend, lot B5b** : l'interface en terminal (`ui/`), l'API des hooks d'événements, Mission Control et le mode Streaming passent à 100 %. Les routes tournent dans une vraie application FastAPI, le serveur de streaming sur un vrai port local, joint par le client `websockets` comme le font l'application et les agents.
- **Couverture du backend, lot B5c** : message de commit, revue d'architecture, détection des
  modèles Ollama et de l'aperçu, contexte et prompts des agents, graphe des modules de la carte
  d'architecture, tous à 100 % par des tests de comportement réels.
- **Couverture du backend, lot B5d** : préparation de la documentation des bibliothèques
  (manifestes de toutes les piles, client Context7, résultat relu entre deux processus) et
  analyse des licences (réponses des registres, manifestes, routes), à 100 % par des tests de
  comportement réels.
- **Couverture du backend, lot B5e** : le module mobile (appareils, démarrage, compilation,
  lancement, capture, journaux, mesures, détection des piles, diagnostic de la machine, section
  du prompt) à 100 % par des tests de comportement réels.
- **Couverture du backend, lot B5e** : le bac à sable de l'OS (`os_sandbox` : sondage,
  commandes bubblewrap et Seatbelt, politique d'accès, liste des hôtes, proxy filtrant, porte
  loopback) à 100 %, proxy compris sur chaque chemin d'une requête et à travers le proxy de la
  machine.
- **Plancher de couverture du backend** relevé de 85 à 88 %.
- **Couverture du backend, lot B5f** : les moteurs OCR des pièces jointes (Tesseract, modèle de
  vision local par Ollama, Azure Document Intelligence, piles Python) à 100 %, chacun face au
  programme ou au serveur qui lui répond ; les fichiers d'une tâche, le garde de lecture, le
  masquage des secrets, les lecteurs C4 et de schémas (draw.io, Excalidraw), les journaux de CI et les connaissances validées à 100 %.
- **Couverture backend, lot B5 (cerveau partagé et Replay)** : `brain/` et `replay/` sont entièrement couverts.
  - Cerveau : le pont des mémoires (frontmatter non fermé, commentaire sur plusieurs lignes, règle proposée par un agent puis confirmée, sauvegarde d'origine gardée, pont rafraîchi), les notes (étiquettes écrites en une valeur, écriture interrompue sans fichier temporaire laissé) et le repli de recherche par mots du vault.
  - Replay : une session enregistrée suivie de l'enregistreur aux routes, en passant par les points de reprise, les forks, le score des décisions et leur carte de chaleur.
  - Code mort retiré, preuves à l'appui : une vérification qui ne pouvait pas se déclencher à la création d'un cerveau neuf, une erreur 500 de la comparaison A/B qui suivait une seconde lecture des deux sessions, et un retour après le dernier type de point d'arrêt.
- 🐛 **Un point d'arrêt sur un fichier précis s'arrête enfin sur ce fichier** : le changement de fichier était vérifié avant que son chemin ne soit attaché à l'étape, si bien qu'un point d'arrêt limité à un chemin ne se déclenchait jamais.
- 🐛 **Un type de point d'arrêt inconnu est refusé avec une erreur claire (422)** au lieu d'une erreur serveur.
- **Couverture backend, lot B5 (Incident Responder)** : `self_healing/incident_responder/` est entièrement couvert : analyse de fragilité, mode CI/CD, mode production, mode proactif, orchestrateur et sauvegarde de l'état. Le plancher de couverture du backend passe de 89 à 92 %.
  - Code mort retiré, preuves à l'appui : la recherche du fichier de test d'un fichier source, la lecture d'un événement Sentry, la normalisation de la gravité, le détail d'un incident et le relevé d'une seule source, que rien n'appelait.
- 🐛 **Le mode CI/CD lance les tests avec la commande de la pile du projet** (.NET, pytest, Vitest, Jest, Maven, Gradle, Go, Rust, PHP, RSpec, Dart, Swift), sans shell et sans les identifiants du backend. Avant, seuls Python, Node, Go et Rust étaient reconnus, et le chemin de pytest ne valait pas sous Windows.
- 🐛 **Le premier commit d'un historique a son diff** dans l'incident CI/CD, et une valeur qui ne désigne aucun commit n'est plus passée à git.
- 🐛 **La couverture Istanbul `coverage-final.json` est lue** (Jest, Vitest, nyc, c8) : un fichier couvert n'y comptait plus comme découvert.
- 🐛 **Le churn d'un projet logé dans un sous-dossier d'un dépôt** compte ses propres commits, et les dossiers `*.egg-info` ne sont plus analysés.
- 🐛 **Un nouveau scan proactif ne double plus les incidents** : un fichier qui a déjà un incident ouvert le garde, avec les mesures du dernier scan. La description cite la vraie période de churn.
- 🐛 **Un incident qu'une version ne sait pas relire n'efface plus les autres** au démarrage, et une opération terminée ne peut plus être annulée.
- 🐛 **Un incident de production relevé garde la source qui l'a signalé**, au lieu d'être attribué à Sentry ou deviné d'après le nom du service.
- **Notifications couvertes à 100 %** : la livraison est testée en vrai HTTP contre un serveur
  local (JSON envoyé, redirection refusée, code d'erreur seul, hôte injoignable), ainsi que
  chaque règle du garde-fou d'URL, chaque format de canal, la route de test et le résumé
  périodique d'une tâche. Le plancher de couverture du backend passe à 93 %.
- **Services du backend couverts à 100 %** : bouclier de rate limit (attente trop longue, reprise
  anticipée, marqueurs impossibles à écrire), historique des tentatives d'un build (fichiers
  abîmés, plan illisible ou verrouillé), annonce d'une tâche terminée (canaux et hooks réels),
  estimation intelligente lue dans une vraie base d'historique SQLite, catalogue des providers.
  Le code jamais appelé est retiré : le classement des échecs, la décision de reprise et le
  retour arrière `git reset --hard` de la reprise, les vérifications de statut et les fonctions
  de compatibilité du catalogue des providers.
- **Un parcours de bout en bout à travers plusieurs features** (#380) : une nouvelle suite E2E
  (`apps/frontend/e2e/journeys/`, lancée avec les autres par le job `e2e`) suit un utilisateur dans
  l'app construite. Premier parcours : la PR d'une tâche d'agent démarre le pipeline Jenkins configuré
  dans CI/CD Triggers, le build rouge devient un incident Self-Healing sur le commit de l'agent, puis
  la personne l'écarte. Le modèle, la forge et la CI sont simulés en local : aucun réseau, aucun
  modèle, et l'app testée démarre sans les identifiants du shell qui lance les tests.
- **Tests sous Windows et macOS** : les tests de l'émulateur d'app tiennent compte des aides que
  Windows lance (libérer le port, arrêter un serveur) ; le clone par la forge simulée reçoit les
  variables sans lesquelles Windows ne lance pas git ; le nom de spec refusé est un nom qu'un
  dossier Windows peut porter ; les petites apps de `verify` écoutent sans attendre la résolution
  du nom de la machine, et le journal lu par la boîte à outils de `verify` est écrit octet pour
  octet.
- **Tests qui dépendaient de l'ordre** : le nettoyage des modules factices remet le vrai module
  que son paquet tient encore, au lieu d'en laisser charger une seconde copie ; la création de MR
  GitLab remplace l'analyse d'impact par un double, au lieu de lancer un vrai modèle quand un
  jeton se trouve dans l'environnement ; les tests des critères QA lisent l'état de build simulé
  même quand un autre fichier a importé `qa.criteria` avant eux.
- **Journal de l'usage lu comme du texte** : le test des traces de débogage du moniteur d'usage
  coupe les couleurs, que le hook de pre-push force et qui découpaient la ligne attendue.
- **Barre de commandes rapides** : le test de `/help` lit la liste dans la notification visible,
  et non dans la copie que l'annonce pour lecteur d'écran ajoute un instant plus tard.
- **Chaque page du menu s'ouvre dans l'app construite sans erreur** : un test E2E Electron ouvre chaque espace de la barre latérale, clique chaque entrée (Labo compris), chaque onglet des hubs et chaque outil qui s'ouvre en dialogue, et échoue sur une exception, un `console.error`, l'écran « Something went wrong » ou une page vide. Une page ajoutée au menu est testée le jour où elle apparaît.
- **Le parcours d'une carte du Kanban, de bout en bout** : création, démarrage, construction par un agent factice (le vrai code d'événements, de phases et de worktree du backend, tout sauf le modèle), revue du diff, vrai « Merge to main », puis Done.
- **E2E du Kanban** : le compte des sous-tâches de la revue a le temps que met le plan terminé à
  être relu.
- **E2E du Kanban** : le test du démarrage attend le worktree et la branche de la carte, que
  l'agent crée un instant après que la carte affiche « Coding ».
- **Les handlers IPC des worktrees de tâche sont testés sur de vrais dépôts git** (lot F1a de la couverture à 100 %) : fusion et aperçu, statut, abandon, liste et orphelins, synchronisation depuis une branche (fusion, rebase, conflit annulé), création de PR, diff du worktree et d'un fichier, lecture, écriture et abandon de fichiers, preuve visuelle, détection et ouverture des IDE et terminaux sur macOS, Windows et Linux. Le backend y est remplacé par un script qui fait à git ce que fait le vrai. Le code jamais atteignable trouvé en chemin est retiré.
- **Les handlers IPC d'exécution des tâches sont testés sur de vrais dossiers de spec et de vrais dépôts git** (lot F1b de la couverture à 100 %) : démarrage, arrêt et reprise de session, statut manuel et création de PR, récupération d'une tâche bloquée, revue humaine (dont une fusion préparée annulée sans toucher aux modifications de la personne), reprise sur un autre moteur, relance d'une phase, changement à chaud, création, duplication, modification et suppression de tâches, fichiers de plan, gestion du contexte, journaux et découpage d'une tâche en parties. Le code jamais atteignable trouvé en chemin est retiré.
- **Les handlers IPC GitHub des issues, de la CI, des journaux de revue et des releases sont testés contre un GitHub simulé** (lot F1c de la couverture à 100 %) : test de connexion, liste des dépôts, pages d'issues reconstituées sans les pull requests, recherche, issue et commentaires, analyse d'une issue en tâche sur un vrai dossier de projet, spec créée depuis une issue, attente de la CI avant une revue sur une horloge simulée, liste des PR en GraphQL, journal de revue sur un vrai dossier, release et suggestion de version sur un vrai dépôt git, et utilitaires (configuration du projet, jeton de gh, appel d'API, projet vérifié, journalisation). Les assistants de projet que personne n'appelait (`withProject`, `withProjectOrDefault`, `withProjectSync`, `withProjectSyncOrNull`) sont supprimés.
- **Couverture frontend, lot F2d (émulateur d'application)** : le service qui reconnaît un projet et lance son serveur de développement passe de 32 % à 98 % des instructions, et ses handlers IPC de 0 % à 100 %. Les tests créent de vrais dossiers de projet (Node, Python, Go, Rust, Docker, .NET récent et ancien, projets fullstack, dossiers de travail WorkPilot), font tourner de vrais serveurs HTTP sur de vrais ports, et ne simulent que les processus lancés et le système d'exploitation.
- **API .NET rangée dans un sous-dossier** : dans un projet fullstack dont l'API .NET est dans `backend/Api/`, `dotnet run` partait de `backend/`, où aucun projet ne se trouve. Il part du dossier du projet .NET.
- **Arrêt pendant le démarrage** : arrêter l'émulateur pendant l'installation des dépendances ou l'attente du port laissait le serveur démarrer quand même, sans plus pouvoir l'arrêter depuis l'app. Un arrêt annule maintenant le démarrage en cours.
- **Ancien serveur qui se termine en retard** : quand le processus d'un serveur arrêté ou remplacé se terminait après coup (taskkill sous Windows), l'app affichait « arrêté » ou une erreur pour le serveur qui tournait, et perdait la trace d'un service fullstack relancé. Seule la fin du processus en cours compte.
- **Services fullstack** : chaque processus n'est tué qu'une fois à l'arrêt, et une configuration sans service principal ne lance plus le premier service deux fois sur le même port.
- Code jamais exécuté retiré : le nettoyage de jonctions Windows que rien ne créait, une seconde vérification du runner Python, une borne de profondeur que la récursion n'atteint jamais.
- **Composants du frontend, premier lot** : les badges Claude Code et Copilot, la page Worktrees, l'assistant de création de tâche, la fenêtre d'édition et la fenêtre du jeton Claude sont rendus et utilisés par leurs tests (installation, changement de version ou d'installation, fusion, PR, suppressions groupées, brouillon, conflit d'édition sur une carte du serveur). Le plancher de couverture Vitest passe de 29,5 % à 42,4 % des instructions.
- **Worktrees** : fusionner un worktree dont la tâche a disparu le dit dans la fenêtre de fusion, au lieu d'écrire l'erreur derrière elle sur la page.
- **Jeton Claude** : choisir un autre compte ne recharge plus la fenêtre (elle réaffichait son chargement et relisait tout à chaque clic) ; les boutons copier la commande et afficher le jeton ont un nom lisible par un lecteur d'écran.
- **Messages traduits** : les erreurs des badges Claude Code et Copilot, de la page Worktrees et de la fenêtre du jeton Claude s'affichent en français, et non plus en anglais en dur.
- **Composants du frontend, deuxième lot** : la configuration GitHub d'un projet, l'indicateur d'usage et son détail (Claude, OpenAI, Copilot), l'ajout d'un projet avec un remote et la fenêtre de limite d'usage sont rendus et utilisés par leurs tests.
- **Configuration GitHub** : ouvrir la fenêtre ne la fait plus tourner en boucle, et le nom d'un nouveau dépôt ne perd plus le focus à chaque lettre tapée.
- **Ajout d'un projet** : le provider choisi juste après avoir tapé l'emplacement n'est plus remis sur « Plus tard » ; les URL de clone Azure DevOps (`https://org@dev.azure.com/…`) sont reconnues ; enregistrer un remote pour un dossier qui existe déjà mène au résumé au lieu d'une fenêtre Git qui fermait l'assistant sans créer le projet ; une URL collée en `.git` ne donne plus son suffixe au nom ; une erreur ne s'affiche plus deux fois.
- **Limite d'usage** : une fois ouverte, la fenêtre ne remet plus le compte suggéré à la place de celui qu'on choisit ; « Ajouter un compte » place bien le curseur dans le champ du nom, quelle que soit la langue.
- **Indicateur d'usage** : avec OpenAI sans données, l'infobulle n'affiche plus un bloc de débogage vide.
- **Messages traduits** : les erreurs de la configuration GitHub, les visibilités du dépôt lues par un lecteur d'écran et le nom de l'opération interrompue par une limite d'usage s'affichent en français.
- **Composants du frontend, troisième lot** : la vue des outils des agents (serveurs MCP du projet et de chaque agent) et la fenêtre d'un serveur MCP personnalisé sont rendues et utilisées par leurs tests.
- **Outils des agents** : la liste des serveurs d'un agent suit celle du build (Electron, Puppeteer et Chrome DevTools seulement quand le projet les active, Linear seulement avec l'intégration Linear) ; les noms et descriptions des serveurs, le vérificateur et son serveur s'affichent en français ; un enregistrement refusé remet l'ancienne valeur ; une vérification d'état refusée ne tourne plus sans fin ; les interrupteurs et les icônes d'état sont nommés pour un lecteur d'écran.
- **Changement de projet** : un enregistrement qui échoue après être passé à un autre projet ne vide plus la configuration de celui-ci.
- **Serveur MCP personnalisé** : vider le jeton d'un serveur le retire ; un nom sans lettre ni chiffre, ou l'identifiant d'un serveur intégré (`github`…), est refusé ; la valeur d'un en-tête n'est plus réaffichée en clair.
- **Fenêtre principale** : la page ouverte par le menu (chacune des soixante), la question posée
  quand on quitte le Kanban pendant un build, les onglets de projet, l'ouverture des réglages par
  les événements, le thème, la langue, le premier lancement et le panneau de tâche sont testés par
  leur comportement. Retiré, avec la preuve : les fenêtres de réglage GitHub et Azure DevOps
  qu'aucun chemin n'ouvrait plus (le fournisseur est détecté tout seul), la fenêtre Azure DevOps
  elle-même, qui ne servait qu'à cet endroit, et une ouverture de terminal jamais appelée.
- **Kanban** : la carte, le tableau (glisser-déposer, sélection en masse, file d'attente,
  imports Azure DevOps et Jira, annulation d'une suppression), les colonnes, la barre d'outils et
  les commandes rapides sont testés par leur comportement. Un faux `window.electronAPI`
  (`src/__tests__/helpers/renderer-api.ts`) répond à toute méthode, pour que chaque test ne
  déclare que les appels dont il parle. Code mort retiré du tableau et de la carte.
- **Menu latéral** : les espaces du rail, « Mon menu » (épingles, pages récentes, premier choix
  du menu), les raccourcis à deux lettres, le glisser-déposer, le redimensionnement et la
  vérification git du projet sont testés par leur comportement. Retiré, avec la preuve : la fenêtre
  d'ajout de projet et les fenêtres GitHub et Azure DevOps qui la suivaient, que le menu ne pouvait
  plus ouvrir (l'app les ouvre elle-même), et la prise en charge de raccourcis d'une lettre (il
  n'en reste aucun ; un test vérifie que chaque raccourci a deux lettres).
- **Couverture frontend, lot F3c (hooks des pages)** : merge requests GitLab, auto-fix et analyse des issues GitHub, issues GitHub et GitLab, images du changelog, import Linear, idéation. Le code jamais appelé est supprimé.
- **Revues de PR GitHub et de MR GitLab** : le panneau de détail suit en direct la revue de la PR ou de la MR choisie (démarrage, progression, résultat) ; il restait figé sur son premier état.
- **Investigations d'issues GitHub et GitLab** : leur progression est suivie même quand la page des issues est fermée ; une investigation terminée pendant ce temps restait « en cours ».
- **Issues GitHub et GitLab** : la liste montre de nouveau qu'elle se charge, et une recherche ou un changement de filtre n'envoie plus chaque requête deux fois.
- **Images du changelog** : les erreurs sont traduites, et une image collée sans extension ou en SVG n'est plus refusée.
- **Import Linear** : changer d'équipe oublie le projet de l'ancienne équipe, et une réponse lente pour un choix précédent ne remplace plus la liste affichée.
- **Idéation** : convertir une sélection d'idées en tâches signale désormais les conversions qui échouent.
- **Couverture frontend, lot F3e (hooks)** : devise, combattants de l'arena, matrice des capacités des providers, statistiques de PR, raccourcis clavier et réglages du projet.
- **Coûts en euros** : un seul service de change sert tout l'écran ; les pages ouvertes ensemble ne le lisent plus qu'une fois, et l'anglais ne le lit plus du tout. La CSP du renderer perd l'hôte `api.frankfurter.dev`, qui ne servait plus à rien (resserrement).
- **Arena** : un provider sans adaptateur propre (LM Studio, par exemple) est reconnu quelle que soit l'orthographe de son nom et n'entre plus dans l'arena.
- **Statistiques de PR** : passer d'une PR à l'autre n'affiche plus les chiffres de la précédente, et le chargement s'arrête quand la PR disparaît.
- **Réglages du projet** : changer de projet pendant le chargement n'enregistre plus la configuration d'un autre projet, et l'état d'une connexion (GitHub, GitLab, Linear, Azure DevOps) se vide quand on désactive l'intégration au lieu de garder l'ancien.
- **Couverture frontend, lot F2a (gestionnaire d'identifiants)** : le service qui choisit le fournisseur actif, teste une connexion et prépare l'environnement du backend passe de 9 % à 100 % (instructions, branches, fonctions, lignes). Les fichiers de réglages et de profils sont tenus en mémoire, les API des fournisseurs répondent par un `fetch` simulé, le serveur LLM local est un vrai serveur HTTP, et la base `state.vscdb` de Windsurf est un vrai fichier SQLite.
- **Test de connexion des profils préréglés** : un profil OpenAI, Mistral ou DeepSeek dont l'URL finit par `/v1` (c'est le cas des profils proposés par l'app) était testé sur `/v1/v1/models`, une 404 : le test échouait avec une clé valide. La vérification des identifiants actifs avait le même défaut.
- **Compte Claude reconnu** : le test de connexion Anthropic ne regardait que le profil Claude actif. La recherche dans les autres profils appelait une méthode qui n'existe pas (`getProfiles`) : un profil connecté qui n'était pas l'actif n'était jamais trouvé, et le test disait « non authentifié ».
- **Fournisseur choisi par une page** : un choix vide n'efface plus le fournisseur des réglages ; le processus partait sans `SELECTED_LLM_PROVIDER` et retombait sur Claude.
- Code jamais exécuté retiré : des `try`/`catch` autour d'appels qui ne rejettent jamais, un cas Ollama et un cas Windsurf que la fonction ne pouvait plus atteindre, deux variables jamais lues. Le gestionnaire de profils Claude est importé pour de bon, et `better-sqlite3` est chargé par un petit module à lui : un `require` au milieu d'une fonction échappait aux tests.
- **Couverture frontend, lot F2b (détection des outils en ligne de commande)** : le module qui trouve Python, Git, `gh`, `glab`, Claude CLI et Copilot CLI passe de 29 % à 100 % des instructions, des fonctions et des lignes (99 % des branches). Les tests décrivent une machine (fichiers présents, réponse de chaque `--version`, PATH, `where.exe`, système) et font tourner la vraie détection dessus, par l'API synchrone et par l'API asynchrone, qui doivent trouver le même outil.
- **Python Homebrew sur macOS** : la détection asynchrone avait sa propre liste, qui essayait `python3` avant `python3.13` et oubliait les versions de `/usr/local/bin` (Mac Intel). Les deux détections lisent maintenant la même liste, de la version la plus récente à la plus ancienne, et la détection synchrone ne lance plus deux fois `--version` sur l'interpréteur retenu.
- Code jamais exécuté retiré : une seconde recherche NVM de Claude CLI, identique à la première et lancée juste après elle, et un test « application packagée ? » refait dans une fonction que seul ce cas appelle.
- **Couverture frontend, lot F3a (stores)** : les stores de l'Idéation, des fonctions de la phase 3 à 5, des tâches du Kanban, du changelog, des terminaux, d'Insights, des colonnes du Kanban et de la marketplace MCP sont testés par leur comportement : ce qu'ils envoient au processus principal, ce qu'ils gardent de la réponse, ce qu'ils affichent d'un refus. Le code jamais appelé est supprimé.
- **Idéation** : ouvrir un projet pendant qu'un autre génère ses idées affiche bien les idées du projet ouvert. La page restait vide, le store lisant encore l'état du projet quitté. Ajouter des types à une idéation existante ne remet plus en attente les types déjà générés.
- **Insights** : une réponse qui arrive pour un projet après qu'on en a ouvert un autre ne s'ajoute plus à la conversation affichée.
- **Marketplace MCP** : installer ou retirer un serveur quand la configuration du projet n'a pas pu être relue est refusé. La liste écrite était celle encore en mémoire, parfois celle d'un autre projet, qui remplaçait les serveurs du projet.
- **Changelog** : une copie dans le presse-papiers refusée par le système s'affiche comme un échec au lieu de passer pour réussie.
- **Annuler une suppression de tâches** : la copie gardée pour l'annulation expire bien au bout de cinq minutes ; elle n'expirait jamais.
- **Couverture frontend, lot F3b (stores et hooks)** : Formula Lab, Agent Time Travel, marketplace de plugins, revues de MR GitLab, filtres du Kanban, console d'administration, projets, génération de tests, Pixel Office, écouteurs des tâches et de la roadmap, réglages de GitHub Copilot. Le code jamais appelé est supprimé.
- **Agent Time Travel** : supprimer un point de contrôle ou un fork que le backend refuse de supprimer ne le retire plus de la liste ; le refus s'affiche.
- **Marketplace de plugins** : une désinstallation qui échoue affiche son erreur au lieu de rien.
- **Revues de MR GitLab** : l'abonnement aux événements des revues est pris une fois au démarrage de l'app, et non plus par la page des merge requests.
- **Administration (mode serveur)** : une action refusée par le processus principal n'affiche plus un chargement sans fin.
- **Projets** : renommer un projet pendant qu'un autre est ajouté ne fait plus disparaître ce dernier de la liste.
- **Couverture frontend, lot F3d (stores des fonctionnalités)** : arena, delta d'architecture, Context Mesh, pair programming, learning loop, contexte du projet, débogueur d'agent, garde-fous, déclencheurs CI/CD et agent navigateur. Le code jamais appelé est supprimé.
- **Arena** : un combat suit sa progression même quand la fenêtre de l'arena est fermée ou sur un autre onglet, et un combat qui échoue s'arrête au lieu de tourner sans fin.
- **Garde-fous et déclencheurs CI/CD** : changer de projet n'affiche plus les règles ou les réglages du projet précédent, et un enregistrement ne peut plus les écrire dans le mauvais projet. Des réglages CI/CD refusés à l'enregistrement ne s'affichent plus comme enregistrés, et l'erreur d'un enregistrement, d'un déclenchement ou d'un rollback du projet précédent ne s'affiche plus sur le nouveau. Une vérification de diff encore en cours pour le projet précédent ne bloque plus le bouton.
- **Contexte du projet** : changer de projet efface l'index et les souvenirs du précédent, et un rafraîchissement des souvenirs du projet précédent ne laisse plus le chargement tourner, et une recherche dans la mémoire montre les résultats de la dernière saisie, pas d'une saisie plus ancienne qui répond en retard.
- **Pair programming** : la page montre la session du projet ouvert avec sa conversation, et non plus celle du projet précédent, même quand un autre projet est sélectionné ailleurs ; une réponse tardive du projet précédent est ignorée. Ses messages d'état sont traduits.
- **Learning loop** : désactiver ou supprimer un pattern met à jour le nombre de patterns actifs.
- **Context Mesh** : une nouvelle analyse repart d'une sortie vide et sans l'erreur précédente, et son état s'affiche dans la langue de l'app.
- **Débogueur d'agent** : un point d'arrêt, une reprise ou un détachement refusé s'affiche au lieu d'échouer en silence, y compris quand le débogueur répond par un refus, et un rafraîchissement arrivé après le détachement ne remet plus l'ancienne session.
- **Delta d'architecture et agent navigateur** : une carte fermée pendant le chargement n'est plus recréée, une capture dont l'aperçu est illisible se termine sans garder l'aperçu précédent, et une suppression de référence refusée est signalée.
- **Frontend** : les tests repassent la vérification des types après deux fusions croisées
  (les miniatures d'image vivent dans `lib/image-attachments`, l'ancien test d'auto-fix des
  issues visait des fonctions supprimées comme inutilisées).
- **Couverture frontend, lot F2c (suivi de l'usage des comptes)** : le moniteur qui mesure l'usage de chaque provider et bascule de compte Claude avant une limite passe de 27 % à 100 % des instructions, des fonctions et des lignes (95 % des branches). Les tests décrivent une machine (profils Claude et API, réglages, trousseaux, réseau par adresse, commande `claude usage`) et font tourner le vrai moniteur dessus : Copilot, Windsurf (cache de l'IDE, clé de service, SSO), OpenAI (plan ChatGPT, clé d'API), Anthropic, cache de 15 s, attente après un 429, échec d'authentification, bascule anticipée.
- **Nom du compte affiché** : l'usage d'un compte Claude prenait le nom du premier profil API Anthropic trouvé, dès qu'il en existait un. Il porte maintenant le nom du compte mesuré.
- **Refus d'identifiants lu dans la réponse** : un refus renvoyé avec un autre code que 401 ou 403 (un 400 qui nomme le jeton) finissait en « Check failed » ; il déclenche maintenant le rafraîchissement du jeton puis, au besoin, la bascule de compte, comme un 401.
- **Bascule de compte Claude** : Windsurf ou Copilot à 100 % ne déclenche plus de changement de compte Claude.
- **Profil Copilot ou Windsurf sans clé** : il était cherché sous l'identifiant du compte Claude actif, une autre liste ; il est cherché sous l'identifiant actif des profils API.
- Le minuteur de 30 s qui borne la lecture de tous les comptes est annulé une fois la lecture finie, au lieu de rester armé à chaque rafraîchissement.
- Code jamais exécuté retiré (220 lignes) : un second contrôle du cache qui ne pouvait jamais répondre, des branches Copilot, Windsurf et OpenAI de la lecture de l'API que d'autres chemins traitent avant elle, une recherche de profil quand l'appelant le donne toujours, une lecture d'API pour des providers sans adresse d'usage.
- **Couverture frontend, lot F2e (preuve visuelle, .NET Framework)** : la preuve d'un client lourd lancé par Mono ou Wine (build MSBuild contre sa solution, restauration des paquets, paquets du dépôt principal prêtés au worktree, capture de sa seule fenêtre, plan de navigation généré ou écrit) et celle d'un site ASP.NET classique hébergé par IIS Express ou xsp sont testées de bout en bout sur de vraies solutions et un vrai serveur HTTP ; seuls MSBuild, dotnet, Mono, Wine et la liste des fenêtres sont simulés. Avec les tests de bout en bout déjà là, le service de preuve visuelle passe à 98 % des instructions.
- **La matrice des routes du serveur nomme les quatre routes de gouvernance** : lecture du
  panneau (`audit.read`), export de la piste d'audit (`audit.export`), réponse à une demande
  d'approbation (`review.approve`) et arrêt des agents (`agent.cancel`), chacune portée par le
  projet. Le test des groupes vérifie aussi qu'une lecture que le rôle contributeur ne détient
  pas, comme l'export, est refusée pour cette permission et seulement elle.
- **Clés des providers** : le test d'un fichier dont on ne peut pas resserrer les droits vérifie
  de nouveau que le chargement a bien essayé de les resserrer, au lieu de partir d'un fichier
  déjà privé qui ne testait plus rien.
- **L'app mobile est couverte à 100 % sur les branches aussi** : chaque écran est testé quand une lecture ou une écriture échoue et quand les données sont plus maigres que d'habitude, et le plancher Jest passe à 100 % partout. Les replis impossibles ont été retirés plutôt que testés (une action de carte non indexée passe par `runPhase`, un bandeau d'erreur reçoit l'erreur elle-même).
- **L'app mobile est couverte à 100 % (instructions, fonctions, lignes)** : tests d'intégration de chaque écran sur un faux serveur (session, verrou, notifications, administration, forge GitHub et GitLab), aperçu web, et un plancher Jest qui empêche la couverture de reculer (branches à 93 % pour l'instant).
- **Connexion mobile** : un serveur qui n'accepte que Microsoft dit d'utiliser « Se connecter avec Microsoft », au lieu d'affirmer que l'app ne le gère pas.
- **Les tests du verdict de revue de PR suivent l'autocontrôle des remarques.** Leurs remarques de
  gravités différentes portaient le même titre au même endroit, que l'autocontrôle fusionne
  désormais en une seule : elles ont chacune leur titre.
- **Réglages du projet** : les tests des vérifications de connexion suivent le comportement fusionné avec le lot F3e : quand les réglages d'une intégration changent, l'ancien résultat est effacé au lieu d'être gardé.
- **Boucle QA** : les tests du scan de sécurité suivent le classement des constats par portée
  (#364) et vérifient qu'il est bien demandé ; `develop` repasse au vert.
- **Test de la revue de suivi à jour** : son faux détecteur de bots connaît `mark_review_finished`, que l'orchestrateur appelle désormais à la fin de chaque revue.
- **Mode serveur, app de bureau** : un parcours de bout en bout contre un vrai serveur couvre les
  vues qu'offre un projet du serveur, la présence et le chat d'équipe, une analyse lancée par une
  personne et lue par une autre, une carte lancée sur le serveur dans l'historique et le tableau de
  bord, la console d'administration (membres, invitation, groupe, audit) et les jetons personnels
  gardés sur le serveur.
- **Mode serveur, forges** : un faux GitHub et un faux GitLab, joints sous leurs vrais noms par un
  proxy et une autorité de certification tirés pour le test, couvrent de bout en bout les issues,
  les pull et merge requests d'un projet du serveur, sur le bureau et le téléphone (commentaire
  compris), lues avec le jeton de chaque personne et jamais avec celui d'un autre.
- **Tests E2E contre un serveur** : le serveur lancé par `e2e/server-harness.ts` reçoit
  l'environnement du développeur sans ses identifiants, comme l'app lancée par
  `e2e/app-harness.ts`.
- **Chaque route du mode serveur et sa permission, sur une vraie base** (lot I1 de la couverture
  à 100 %). Deux organisations, tous les rôles, un groupe et des dépôts git réels : une matrice
  vérifie la règle de chacune des routes servies (sans jeton, jeton falsifié, permission manquante,
  autre organisation, rôle de projet), et des parcours couvrent connexion, projets, specs et runs,
  administration, invitations et réglages personnels (`tests/server_routes/`).
- **Tests backend lancés par le script `pytest`** : trois tests qui exécutent l'interpréteur courant comme commande (bac à sable de l'agent de spec, commandes locales, délégation de bout en bout) le nomment `python`, le nom que l'allowlist connaît (`tests/allowlisted_python.py`). Sous le script `pytest` d'un venv, l'interpréteur s'appelle `python3.12` : ils n'y passaient pas, le hook de commit des fusions compris.
- **Tests du pipeline spec isolés** : `test_spec_pipeline.py` et `test_spec_phases.py`
  remplaçaient une soixantaine de modules par des faux dans `sys.modules` au moment de
  l'import. Les fichiers collectés après eux recevaient ces faux, et
  `spec_creation/test_orchestrator_parts.py` échouait quand il tombait dans le même shard. Les
  deux fichiers testent maintenant les vrais modules.
- Les tests du moniteur d'usage repassent : leur faux `child_process` répond aussi à `execFile`,
  que charge désormais le suivi d'usage de Codex.
- **Tests d'authentification indépendants de l'ordre** : ils défont le jeton que le code écrit dans l'environnement, qui faisait démarrer le vrai CLI dans un test suivant.
- **Retour arrière d'un instantané de tâche** : la restauration écrit chaque fichier de l'instantané depuis un index vide, sans se fier au cache de l'index du worktree, qui pouvait laisser un fichier dans son état d'avant le retour arrière (vu sous Windows avec Git 2.56.1).
- **Worktree à la racine d'un lecteur Windows** : la détection d'isolement du worktree renvoie la racine du lecteur (`D:\`) comme projet parent, et non `D:`, qui désigne le dossier courant de ce lecteur ; le chemin du dossier de spec donné aux agents s'écrit avec des `/` sous Windows aussi.
- **Les tests du worktree suivent le nouveau moteur de fusion.** Le backend ne charge plus le suivi de
  chronologie supprimé, et les tests de dépôt partagé relisent leurs fichiers sans la configuration
  git de la machine (sous Windows, `core.autocrlf` les faisait passer pour modifiés).

### 📚 Documentation

- Les index `apps/backend/AGENTS.md`, `apps/frontend/AGENTS.md` et celui du Kanban repassent sous la taille que Codex lit en entier.
- L'index `apps/backend/AGENTS.md` repasse sous la taille que Codex lit en entier.
- **README (anglais et français), `docs/FEATURES.md` et wiki à jour des fonctionnalités arrivées
  depuis la 1.5.0** : Comptes IA et basculement pour tous les providers, nom du forfait, bac à sable
  et score de confiance, coupe-circuit, budgets, mode Essaim, vagues d'exécution, REA, WinDev,
  migration de code, pair programming avec l'IA, cycle de vie de la mémoire, menu arrangé par
  chacun. Les onze captures du README sont reprises et quatre s'ajoutent (Comptes IA, Bac à sable,
  Migration de code, Personnaliser le menu).
- **Kanban agile** : README EN/FR, FEATURES et wiki présentent le tableau agile (colonnes Échec et
  Abandonnée, sprints, couloirs, liste, frise, rapports, étiquettes), avec quatre nouvelles captures.
- **README EN et FR complets** : la matrice d'appareils (réseau bridé, éléments qui se chevauchent, texte coupé, export PNG) et la surveillance après déploiement (rapport d'incident, PR de revert) retrouvent les phrases qu'une fusion avait perdues.
- **Un guide pour paramétrer, configurer et utiliser le serveur d'équipe**
  ([`docs/server-guide.md`](docs/server-guide.md)). Démarrage rapide pour les trois hébergements,
  format de `.env.server` et de chaque type de valeur, exemples complets (VPS avec Microsoft et
  e-mail, réseau local, essai, SSO OpenID Connect, approbations à plusieurs), rôles, groupes,
  projets, quotas, usage depuis l'app et le téléphone, accès MCP, l'API avec `curl` et ses codes
  de réponse, et un tableau de dépannage.
  Les deux README, `FEATURES.md` et `CONFIGURATION.md` y renvoient, et le wiki gagne une page
  « Serveur d'équipe » en anglais et en français.

### 🧹 Maintenance

- **Index AGENTS.md du frontend raccourci une seconde fois** : la ligne du trousseau Linux l'avait refait dépasser la limite de 32 Kio que Codex lit pour la chaîne du Kanban ; trois lignes renvoient maintenant à leur page `docs/architecture/` pour le détail, ce qui laisse un peu de marge.
- **Index AGENTS.md du frontend raccourci** : trois PR fusionnées ensemble l'avaient fait dépasser de quelques octets la limite de 32 Kio que Codex lit pour la chaîne du Kanban.
- **Code mort retiré** : `security/secure_subprocess.py` (`run_secure`). Son seul appelant, la détection de Copilot dans les logs, passe désormais par `core.gh_executable` ; plus rien ne l'importait.
- **Comptage des autres builds sous Windows** : le test qui vérifie qu'un autre build est compté nomme, quand il échoue, ce que le compteur a vu de chaque processus (ligne de commande, chemin résolu), pour corriger la cause propre à Windows.
- **Plancher de couverture backend à 76 %** : la CI refuse désormais une couverture pytest sous
  76 % (`apps/backend` et `src/`), au lieu de 75 %.
- **Connecteurs inutilisés retirés** : Postman, SonarQube, notifications (Slack/Teams) et le
  client « work items » de Jira n'étaient appelés par aucune partie de l'app ; la couverture des
  tests mesure désormais aussi `src/` (connecteurs), à 100 %.
- **Code mort retiré, lot B5b** : dans Mission Control, les nœuds de décision et méthodes que rien n'appelait ; dans le Streaming, les émetteurs du gestionnaire que seuls les agents utilisent par leur wrapper, l'enregistreur inutilisé du serveur, la suppression et les statistiques d'enregistrement, et la prise en charge d'anciennes versions de `websockets` (la version requise est 17.4).
- **API locale** : les routes HTTP que plus rien n'appelait sont retirées. Le tableau de bord
  (`/api/dashboard/snapshot`, `/stats`, `/export`) est construit par l'application depuis les
  relevés du projet. Refactoring, documentation et revue de code passent par leurs runners
  (`code_insights_runner`, `documentation_runner`). Les modèles de tâches et les statistiques de
  feedback n'avaient aucune vue. L'historique des sessions et les panneaux hermes et ui-ux-pro-max
  sont couverts à 100 %. Le lien d'une décision hermes vers sa tâche lit le chemin donné comme
  un nom, sans le résoudre.
- **API locale** : des routes HTTP que plus rien n'appelait sont retirées. Les analytics
  (`/analytics/*` et leur repli vide) : le tableau de bord Analytics est construit par
  l'application depuis les relevés du projet, et la base des analytics reste, écrite par les builds
  et lue par les estimations et la santé des agents. L'état des sous-systèmes
  (`/api/router/config`, `/api/local-models/status`, `/api/costs/*`, `/api/scheduler/jobs`,
  `/api/auto-detect/status`) et l'état du nettoyage des watermarks (`/api/watermarks/status`),
  qu'aucune vue ne lisait.
- **API locale, filets de test** : les routes de la santé des agents, de la dérive d'architecture,
  de l'i18n Auto-Scaler, du pair programming et du journal d'audit sont couvertes à 100 %, les
  branches qu'aucune requête ne pouvait atteindre étant retirées.
- **Backend** : quatre modules de planification que plus rien n'appelait sont retirés, avec leurs
  tests : le routeur « intelligent », le gestionnaire de modèles locaux, l'auto-détection et les
  modèles de tâches (environ 3 600 lignes). Le routage des modèles passe par `model_router/`, les
  modèles locaux par le catalogue des providers et la détection d'Ollama.
- **CI de develop remise au vert** : le faux environnement du test d'arrêt d'urgence suit la nouvelle signature (projet passé à l'environnement du run) ; la lecture JSON des vagues refuse un lien aussi sous Windows, qui n'a pas `O_NOFOLLOW` ; le test des droits du fichier de run attend ce que Windows donne ; ruff à la racine ignore les packs de skills épinglés à l'amont et la sortie générée `.agents/`, comme déjà BMAD.
- **CI de develop remise au vert (suite)** : les chaînes `AGENTS.md` du backend (sécurité) et du Kanban repassent sous la limite de Codex, des lignes longues renvoyant désormais à leur doc d'architecture ; le faux pont du test des comptes IA est typé, ce qui rend à `tsc` un test d'échec avec `error`.
- **CI de develop remise au vert (fin de journée)** : le runner des paliers d'approbation masque les secrets de ses logs dès son lancement, comme les autres runners ; le panneau « Interroger le tableau » suit l'échelle de texte de l'app (tailles en rem) ; le test de coercition du modèle local n'interroge plus le bac à sable de son faux client.
- **Tests : le test du minuteur de dictée laisse React démarrer l’horloge avant d’avancer le temps, et ne dépend plus de la charge de la machine.**
- **Faux `gh` des tests fidèle sous Windows** : il écrivait ses réponses en mode texte, donc avec des `\r\n` que le vrai `gh` n'envoie jamais ; le test du diff d'une PR échouait sur Windows seulement.
- **Tests frontend** : l'exception de `platform-abstraction.test.ts` pour le journal de diagnostic
  de `settings-handlers.ts` suit la ligne déplacée par une fusion, ce qui remet develop au vert.
- **Test des options de PR du serveur remis au vert** : son faux Spec n'avait pas l'auteur ni le nom que la route lit maintenant pour décider si une carte peut partir sans revue.
- **Tests : le test de la fenêtre de limite d’usage ne dépend plus du moment où Radix annonce la notification.**
- **Les versions sortent toutes seules, au plus une par jour.** Quand `develop` n'a reçu aucune
  fusion depuis 2 h et que la version précédente a au moins 24 h, le pilote de release
  (`release-autopilot.yml`) déduit majeure, mineure ou patch des PR fusionnées (`feat`, `fix`,
  `!`/`BREAKING CHANGE`, fragments, labels `semver:*`), fait écrire par Claude Code la
  documentation de la version (README EN/FR, docs, wiki), ouvre `release/vX.Y.Z` → `main`, la
  fusionne par commit de merge quand elle est verte, puis fusionne `main` dans `develop`.
- **Ancien auto-réparateur retiré** : la CLI `python -m self_healing` (`check`, `heal`, `monitor`, `report`) et ses modules (moniteur, planificateur, moteur de refactoring, alertes, bilan de santé, dette technique, préréglages) ne sont plus livrés. Rien dans l'app ne les appelait : la vue Auto-guérison passe par l'Incident Responder. Ce moteur travaillait dans le checkout du projet au lieu d'un worktree, et il committait tout le dossier sans ouvrir de PR. Le README du paquet décrit maintenant l'Incident Responder.
- **Replay et revue de PR** : les enregistrements du Replay et du Time Travel passent par un seul module de stockage, nommé par les identifiants qu'ils créent ; la revue d'une PR lit le contexte du projet avec le constructeur de contexte de WorkPilot.
- **Synchronisation hebdomadaire des skills fusionnable** : sa PR est poussée et ouverte avec
  `PAT_TOKEN`, comme celles des autopilotes. Ouverte avec le jeton par défaut, elle ne recevait
  aucun check et ne pouvait jamais être fusionnée.
- **Création de spec** : les anciens recours à des scripts `planner.py` et `context.py` placés dans le projet sont retirés ; WorkPilot n'en livre plus depuis longtemps. Le plan vient toujours de l'agent de planification, et `context.json` est écrit directement à partir de la tâche.
- **Hook git de la frise des fichiers** : le hook `post-commit` que WorkPilot ajoutait au dépôt n'est plus installé. Il appelait un module qui n'existe plus et n'a donc jamais rien enregistré. Au premier build, WorkPilot le retire du projet : un hook entièrement à lui est supprimé, et un hook auquel il s'était ajouté retrouve son contenu d'origine. `merge/install_hook.py` et `merge/tracker_cli.py`, qui n'avaient pas d'autre usage, sont supprimés.
- **Tests Windows des vagues et des vidéos de rejeu remis au vert** : ils comparaient au chemin court du dossier temporaire (`RUNNER~1`) alors que le code résout le nom long ; un dossier de projet qui est un fichier est maintenant refusé de la même façon sur tous les OS.

---

## 1.5.0 - Garde-fous en code, red team et agents qualité pour toutes les stacks

Les règles des agents deviennent une politique versionnée qu'ils ne contournent pas, chaque résultat
d'outil est analysé avant d'être lu, et un agent red team attaque ce que la tâche a construit. Les
agents qualité (accessibilité, i18n, contrats d'API, dérive de la doc, tests instables, migrations,
conformité) couvrent toutes les stacks et corrigent sur une branche de revue. Le Release Train livre
lui-même les services, le chirurgien de l'historique nettoie une branche, le Best-of-N a un arbitre,
l'empreinte carbone a un budget, les notebooks s'exécutent en noyau neuf, et le coach apprend votre
style pour le donner aux agents.

### ✨ Nouveautés

- **L'agent d'accessibilité note le projet, ouvre l'application lancée et corrige sur une branche de revue** (F192). Les règles WCAG 2.2 lisent toutes les stacks de la même façon (HTML, JSX/TSX, Vue, Svelte, Astro, Angular, Razor/Blazor, PHP/Blade, Twig, ERB, Handlebars, et le CSS) et se taisent quand la source ne sait pas (attribut lié, props étalées, composant inconnu) ; nouvelles règles de contraste, focus visible, taille des cibles, titres, langue, rôles ARIA, zoom. Un score de 0 à 100 par critère et par page, avec son historique ; le scan dynamique (App Emulator ou localhost) parcourt la page au clavier et lit l'arbre d'accessibilité ; les corrections simples (alt, aria-label, lang) se font sur une carte de revue, jamais dans le dossier ; export HTML, CSV et PDF ; Import Design affiche le score du code généré (#391).
- **Le coach apprend votre style et le donne aux agents** (F203). Dans chaque projet, le coach lit votre historique git (vos commits, les builds gardés tels quels, ce que vous avez corrigé après un merge) et la configuration du lint, puis mesure par langage douze habitudes : casse des noms, longueur des noms et des fonctions, commentaires et leur langue, imports, gestion des erreurs, retours anticipés, forme des tests. Seules les préférences nettes sont données au codeur et au correcteur QA, pour tous les providers, avec des phrases fixes : la tâche, la spec et le `AGENTS.md` du projet passent toujours avant. La page Coach montre le profil, vous laisse imposer ou retirer chaque valeur, couper le profil, l'exporter sans e-mail ni code, l'importer dans un autre projet et comparer une tâche en revue avec votre style. Elle indique aussi la part des builds gardés sans correction, avec et sans le profil (#376).
- **La veille des contrats d'API compare la branche avec sa cible** (F191). OpenAPI, GraphQL et protobuf sont comparés contrat par contrat à la base de fusion, sans modèle : ce qui supprime ou resserre est cassant, ce qui élargit ou déprécie peut l'être, ce qui ajoute ne l'est pas. Chaque changement liste ses consommateurs, ceux du registre `.workpilot/api-consumers.yaml` et le code du dépôt qui cite l'endpoint, dans toutes les piles. Une rupture voulue se déclare avec `x-breaking-acknowledged`. La porte QA `WORKPILOT_QA_API_CONTRACT` (`warn` par défaut, `strict` pour bloquer), une section « API contract changes » dans la PR, le bouton « Comparer avec une branche » de la page API Watcher, `python -m api_watcher check` et un workflow CI épinglé à copier (#389).
- **Un arbitre départage les variantes d'un Best-of-N qui ne font pas la même chose** (F201). Quand les variantes terminées s'écartent l'une de l'autre (similarité de leurs fichiers changés sous un seuil, 0,3 par défaut, réglable par `WORKPILOT_ARBITER_DIVERGENCE`) ou qu'aucune n'est seule en tête, l'arbitre est consulté juste après le classement, avec le modèle du réglage « Arbitre du Best-of-N », de préférence d'un autre fournisseur que les variantes. Il lit les chiffres du classement et le patch de chaque variante, cités comme données, et répond : la variante qu'il garderait ou une fusion fichier par fichier, une raison par axe (exactitude, sécurité, tests, maintenabilité, performance), les risques des variantes écartées et sa confiance. À confiance basse, ou si sa réponse n'est pas un verdict valide, la carte vous laisse trancher sans verdict inventé ; deux approches équivalentes donnent la plus simple. Vous pouvez contester le verdict (« pourquoi pas B ? », dix questions au plus), et la carte dit quand l'arbitre tourne sur le même fournisseur qu'une variante. Le verdict reste un conseil : vous choisissez la variante à garder, et ce choix est enregistré pour mesurer, mois par mois, la part de verdicts suivis (#368).
- **L'empreinte carbone des modèles a un budget mensuel, des conseils et un export ESG** (F200). La page « Empreinte carbone » estime l'énergie et le CO₂ de chaque appel de modèle des agents, à partir des tokens (lectures du cache comptées à part), de la taille du modèle, du PUE de l'hébergeur et de l'intensité carbone de son réseau ; les modèles locaux comptent la puissance de votre machine sur votre réseau. Chaque chiffre est présenté comme une estimation, et un hébergement supposé est signalé. Vous voyez le mois par phase, par tâche, par fournisseur et par modèle, son équivalent en kilomètres de voiture, la tendance des derniers mois et des conseils tirés du registre : revue sur un modèle rapide, cache de prompts, région plus propre, local ou cloud. Un budget en kg CO₂e par mois envoie une alerte à votre seuil puis à 100 %, une seule fois chacune, sur le bureau et sur votre canal ntfy ou Telegram. En mode dégradé, une fois le budget atteint, les modèles les plus lourds passent au modèle standard de leur fournisseur. L'export du mois en JSON, CSV ou Markdown suit la CSRD (ESRS E1-6 : cloud en Scope 3 catégorie 1, local en Scope 2) et GRI 305-3 / 302-1, avec la méthode et les facteurs (#365).
- **Le collecteur de preuves de conformité juge chaque contrôle avec des preuves datées** (F197). Sans modèle et sur toutes les stacks, il relit ce que les tâches et le dépôt contiennent déjà : approbations de spec, revues QA, tests, contrôles de sécurité, fusions relues, versions, politiques, procédures, supervision, pipelines et incidents. Chaque contrôle de SOC 2, ISO/IEC 27001:2022, HIPAA ou PCI DSS 4.0 (fichiers YAML, complétés ou remplacés par ceux du projet) est couvert, en échec, périmé ou manquant à la fin du mois, avec ses recommandations en français et en anglais. Le rapport du mois écoulé s'enregistre chaque mois dans `.workpilot/compliance/reports/`, un contrôle sans preuve depuis plus de 30 jours est signalé sur le bureau et sur ntfy ou Telegram, et le rapport s'exporte en PDF, CSV, JSON ou HTML (#357).
- **Le détecteur de dérive lit les commentaires de doc, les exemples et l'historique git** (F196). Sur toutes les stacks et sans modèle, il signale un commentaire de doc qui nomme un paramètre que le code ne prend plus (`@param`, `<param>`, docstrings Google, NumPy, Sphinx, rustdoc, Swift…), un exemple de code qui ne se lit pas, importe ce que le projet n'a plus ou appelle une fonction avec des arguments qu'elle n'accepte plus, et un document dont le code a changé depuis son dernier commit. Chaque document reçoit un score de fraîcheur, les traductions sont vérifiées chacune de leur côté, et `<!-- no-drift-check -->` exclut ce qui décrit une autre version. Les dérives simples (paramètre renommé, type de docstring, fichier déplacé) se corrigent en un clic sur une carte de revue, le rapport s'exporte en JSON ou HTML, et une porte QA (`WORKPILOT_QA_DOC_DRIFT`) comme `python -m doc_drift_detector check` signalent la dérive d'une branche (#354).
- **Le détecteur de tests instables dit pourquoi, suit l'évolution et crée la carte pour corriger** (F195). Chaque test signalé reçoit un verdict (instable, ou plus probablement un vrai bug quand il échoue presque toujours), les lignes de son propre code qui l'expliquent (attente fixe, horloge, réseau, état partagé, threads, mise en place sans nettoyage), sur toutes les stacks et sans modèle, et son historique : pire ou mieux que la dernière fois, en CI seulement, sur quels systèmes. Les seuls suspects peuvent être relancés avec le filtre de leur stack (`pytest -k`, `vitest -t`, `dotnet test --filter`, `go test -run`, `mvn -Dtest`, `gradle --tests`). Un clic crée une carte Kanban pour corriger le test (ni saut, ni relance) ou le mettre en quarantaine dans les termes de son framework (#351).
- **Le chirurgien de l'historique Git nettoie une branche sans toucher au code** (F198). Il propose un plan par règles, sans modèle et pour toutes les stacks : les `fixup!` et les correctifs vagues rejoignent leur commit, mais seulement dans la même partie du projet ; les messages sont reformulés selon la convention du projet (Conventional Commits, Gitmoji ou motif propre) ; les commits qui mêlent migrations, code, tests et doc sont découpés. Les auteurs, les co-auteurs, les trailers et les `(#123)` sont conservés. Le modèle configuré peut rédiger les messages, quel que soit le fournisseur, à partir des messages et des chemins seulement. Le plan, modifiable, est rejoué sur une nouvelle branche locale dont les fichiers sont identiques à ceux de la branche, octet pour octet. Rien n'est poussé ni forcé. La page liste aussi les branches locales fusionnées, orphelines, anciennes ou mal nommées, et supprime seulement les branches fusionnées que l'on choisit (#360).
- **Garde-fous en code : une politique versionnée que les agents ne contournent pas** (F185). Un `workpilot.policy.yaml` à la racine du dépôt, une couche globale (`~/.workpilot/guardrails.yaml`) et la couche projet de Réglages → Garde-fous s'empilent sans qu'une couche puisse affaiblir l'autre. Nouvelles conditions sur toutes les stacks : test supprimé, dépendance ajoutée à un manifeste, fichier nouveau trop long, lignes ajoutées, glob de chemin, branche, message à l'agent. `require_approval` attend désormais une approbation à usage unique au lieu de refuser, et l'écran montre les couches lues, les demandes en attente, l'activité des règles et un essai à blanc des changements du dépôt. Une politique invalide refuse tout jusqu'à correction (#377).
- **Les garde-fous s'appliquent enfin dans les worktrees des tâches** (F185). Ils étaient cherchés dans le worktree, où `.workpilot/` n'existe pas, et les règles de chemin ne voyaient jamais les chemins absolus envoyés par le SDK Claude.
- **L'analyse i18n propose les clés, trouve ce qui est faux et traduit sur une branche de revue** (F193). Chaque texte codé en dur reçoit une clé dans le style du projet et l'appel à coller pour sa stack ; les clés orphelines (en tenant compte des clés construites à l'exécution), les phrases restées en langue de référence, les variables qui diffèrent, les formes de pluriel de chaque langue (CLDR) et les styles qui ne s'inversent pas en droite à gauche sont signalés, avec un score de complétude par langue. Les clés manquantes peuvent être traduites par le modèle actif sur une carte de revue, jamais dans le dossier du projet ; une traduction qui perd une variable ou une balise est écartée. Les catalogues YAML de Rails `en.yml` / `fr.yml` sont enfin comparés entre eux (#346).
- **La page Notebooks lit les dépendances entre cellules, exécute le notebook et change les cellules longues en fonctions** (F202). Pour chaque notebook (Jupyter avec n'importe quel noyau, .NET Polyglot, Quarto, R Markdown), la page montre quelle cellule a besoin de quelle autre, l'ordre qui marche quand celui du notebook ne marche pas, et signale une variable lue avant d'être définie, un état caché laissé par une exécution hors ordre, une mutation partagée ou du code dupliqué ; Python est lu exactement, les autres langages par leurs déclarations, et la page le dit. « Exécuter » lance le notebook dans un noyau neuf, dans une copie temporaire et sans vos identifiants : score de reproductibilité, sorties comparées à celles enregistrées, erreurs, assertions en échec, paquets manquants (avec la commande pour installer un noyau absent), figures vides, tableaux qui ont changé de forme. Les cellules Python de plus de 50 lignes peuvent devenir des fonctions dans un module à côté du notebook, avec un nettoyage facultatif des sorties ; ce changement est préparé sur une carte de revue, jamais dans votre dossier. Un historique mensuel suit les vérifications, les exécutions et les fonctions extraites (#371).
- **L'onboarding raconte l'histoire du code, pour chaque rôle** (F194). Un nouvel onglet « L'histoire du code » dit en cinq chapitres comment le projet est organisé (par stack s'il en a plusieurs), où il démarre, quel module est le plus critique, où il est fragile et ce que l'équipe a décidé. Les points chauds sont mesurés dans l'historique git (commits et personnes sur un an), les points de décision, les zones sensibles (sécurité, facturation, migrations, infrastructure) et les tests manquants, sur toutes les stacks ; les décisions viennent des ADR, des commits cassants et de la mémoire du projet. La visite se filtre par rôle (full stack, frontend, backend, DevOps), se masque pour qui connaît déjà le projet, est régénérée quand un module apparaît ou disparaît, et s'exporte en Markdown ou en page web. Le modèle actif peut raconter chaque chapitre en prose, dans la langue de l'app ; tout le reste se fait sans modèle (#349).
- **Essai à blanc : le plan d'une spec est répété avant le build** (F183). La page « Aperçu des changements » devient « Essai à blanc », avec un onglet « Répétition du plan » : chaque sous-tâche est rejouée sur les fichiers de la branche de base, sans rien écrire ni appeler de modèle. Elle signale un fichier modifié avant d'être créé ou absent de la branche, un chemin hors du projet, deux sous-tâches parallèles sur le même fichier, une vérification qui ne peut pas tourner (`dotnet test` sans projet, `cargo` sans `Cargo.toml`, script npm absent…), et répond aux vérifications d'API par un mock tiré du contrat OpenAPI du dépôt. Le rapport donne un verdict, l'empreinte prévue en fichiers et l'estimation du coût du vrai build. L'aperçu des changements non commités reste le second onglet (#373).
- **Un incident de production devient une carte bug-fix** (F187). Une nouvelle automatisation, « Incident de production », lit à chaque passage le dossier `.workpilot/incidents/` du projet. N'importe quel outil peut y déposer un payload Sentry, Datadog, CloudWatch, New Relic, PagerDuty, Grafana ou OpsGenie. Si la règle nomme un projet Sentry, elle lit aussi les issues que Sentry voit pour la première fois après sa création, avec `SENTRY_AUTH_TOKEN` du `.env` du projet. Chaque incident crée une carte `bug_fix` : la carte écrit d'abord le test de régression qui reproduit l'incident et échoue, dans le framework de la stack fautive, puis le correctif, sur sa branche et dans sa PR. Les données personnelles sont masquées, et le texte de l'incident est traité comme une donnée. Aucun port n'est ouvert sur la machine. Sur un serveur, la règle lit Sentry avec le jeton Sentry de la personne qui l'a enregistrée (« Mes jetons sur le serveur »), sur sentry.io ou un hôte de `WORKPILOT_SENTRY_HOSTS` (#384).
- **Red team : un agent essaie de casser ce que la tâche a construit** (F186). Après l'approbation de la QA d'une tâche complexe, une session écrit des tests d'attaque (entrées malformées, cas limites, injection de prompt sur le code qui appelle un modèle, concurrence, anciens bugs) dans le framework de test du projet, toutes stacks, dans une copie jetable du worktree ; WorkPilot les lance lui-même. Une erreur non gérée qui s'échappe du code de la tâche renvoie au fixer ; une réponse différente est affichée dans l'onglet Qualité de la tâche sans bloquer ; un échec qui ne se reproduit pas est écarté. Les passes suivantes rejouent les mêmes attaques sans modèle, et « Attaquer » sur la carte en lance une neuve. `WORKPILOT_QA_RED_TEAM` règle quand elle tourne (#381).
- **Le Release Train livre lui-même les services, dans l'ordre** (F199). Le fichier `release-train.yaml` du projet dit comment chaque service se déploie, revient en arrière et se vérifie : une commande (script, `kubectl`, `gh workflow run`…, jamais une ligne de shell) ou une URL de santé. Le train calcule les vagues d'après les dépendances, la criticité d'abord, et signale un cycle avec le lien à couper. Il lance chaque déploiement, puis le contrôle de santé, puis le smoke test, avant de passer au suivant. En production, chaque service attend votre clic. Un service externe attend que vous disiez qu'il est prêt. Après un échec, vous choisissez : réessayer, revenir en arrière sur la chaîne (les services livrés qui en dépendent d'abord, flags désactivés avant) ou s'arrêter. Le train gère aussi le déploiement express d'un hotfix, les feature flags Unleash, LaunchDarkly, ConfigCat ou manuels, un calendrier qui signale les créneaux en conflit, des notes de version agrégées (résumé facultatif par le modèle configuré) et les métriques du mois. Rien ne s'exécute avant que vous ayez approuvé cette version exacte du fichier (#362).
- **Garde des migrations : ce que les migrations d'une tâche font à une base en production** (F189). Après la QA, WorkPilot lit les migrations écrites par la tâche, sur toutes les stacks (EF Core, Django, Alembic, Rails, Laravel, Doctrine, Knex, Sequelize, TypeORM, Ecto, et le SQL de Prisma, Drizzle, Flyway, golang-migrate, Diesel, Supabase), sans modèle ni base. Perte de données, renommage, colonne NOT NULL sans défaut et migration déjà appliquée modifiée sont des erreurs ; index sans `CONCURRENTLY`, contrainte sans `NOT VALID` sur PostgreSQL, changement de type et `down` manquant sont des avertissements, chacun avec la recette de l'outil et le plan expand → migrate → switch → contract. Carte dans l'onglet Qualité de la tâche, avec « Revérifier ». Non bloquant par défaut ; `WORKPILOT_QA_SCHEMA_GUARD=strict` ou la porte dure `migration-safe` renvoient une erreur au fixer (#386).

### 🐛 Corrections

- **La release se construit enfin sur le tag** (F184). `pnpm run package:linux -- --publish never` transmettait un `--` littéral avant `--publish never` ; electron-builder s'arrêtait à ce `--`, ignorait l'option et tentait de publier lui-même avec le jeton en lecture seule du job. Les builds du tag de 1.4.0 et 1.4.1 échouaient ainsi sur un 403 sur les quatre plateformes, et chaque version devait être relancée à la main. Le script de packaging retire ce `--`, et un test vérifie ce que reçoit vraiment electron-builder.
- **« Installer SOUL.md » marche aussi dans l'app installée** (F188). La persona hermes proposée par WorkPilot quitte la racine du dépôt pour `apps/backend/hermes/SOUL.md`, à côté du code qui l'installe : elle part désormais avec le backend, alors que l'app installée ne l'embarquait pas et répondait « this repository ships no SOUL.md ».

### 🔒 Sécurité

- **Application mobile : deepmerge corrigé contre l'empoisonnement de prototype** (GHSA-gcqx-w48m-w2h4, CVE-2026-93753). Aucune version corrigée n'existe en amont : Jest, seul utilisateur de deepmerge, reçoit une copie de la 4.3.1 qui ignore la clé `__proto__` et écrit chaque propriété comme propriété propre ; elle disparaîtra à la première version corrigée.
- **Chaque résultat d'outil est analysé avant que l'agent ne le lise** (F190). Fichier lu, page récupérée, sortie de commande, réponse MCP : sur les providers de la boucle WorkPilot et sur Claude, un résultat suspect arrive encadré derrière un avertissement, et avec `WORKPILOT_TOOL_RESULT_GUARD=block` un résultat bloqué est retenu. Les motifs reconnaissent désormais l'espagnol, l'allemand, l'italien, le portugais, le chinois et le japonais. La page Injection Guard liste ce qui a été signalé dans chaque tâche (la source seule, jamais le contenu) et les sources de confiance à exempter, comme des fixtures de test ; les agents ne peuvent pas modifier cette liste (#388).

---

## 1.4.1 - Tout code généré passe par une revue, et le menu de gauche s'allège

Toute page qui écrit du code dans votre projet (studio de tests, Import Design, journal des
modifications, pair programming, commande rapide) le fait désormais sur une branche de revue, comme
une carte du Kanban, et le menu de gauche passe à un rail d'espaces avec « Mon menu », quatre hubs et
un Labo pour les pages en bêta. Le Kanban gagne une colonne « PR ouverte » et la purge des worktrees,
les diffs prennent les couleurs de git, l'assistant de premier lancement configure toutes les IA, et
les alertes de dépendances sont corrigées.

### ✨ Nouveautés

- **CI/CD Triggers se déclenche tout seul.** Avec « Déclencheurs actifs » coché, le pipeline configuré (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) démarre quand un agent ouvre la PR d'une tâche et, si « Déclencher à la fusion » est coché, quand cette PR est fusionnée. Les détails de la tâche disent quel pipeline a démarré, ou pourquoi il n'a pas pu ; la liste des exécutions marque celles lancées automatiquement avec leur tâche. Les deux réglages n'étaient jusqu'ici qu'affichés (#378).
- **Des diffs aux vraies couleurs de git, plus lisibles**. Dans « Fichiers modifiés » d'une carte,
  la revue guidée, la revue de code et les fichiers d'une sous-tâche, une ligne ajoutée est verte
  et une ligne supprimée rouge dans tous les thèmes, avec ses marqueurs `+` / `-`. Le code est
  coloré selon son langage (C#, TypeScript, Python, Go, Rust, Java, Kotlin, Swift, Dart, PHP,
  Ruby, SQL, YAML, Vue, HTML, XML…), les mots modifiés d'une ligne réécrite sont surlignés, et
  chaque bloc indique combien de lignes inchangées le séparent du précédent et dans quelle
  fonction il se trouve. Le nouveau mode « Auto » met un fichier côte à côte seulement s'il a des
  lignes supprimées et ajoutées et que la fenêtre est assez large ; un fichier ajouté ou supprimé
  reste en une colonne, sans moitié vide. Chaque fichier affiche son diffstat (`+12 -3 ■■■■□`).
- **Colonne « PR ouverte » sur le Kanban** : une carte dont la pull request est ouverte n'est
  plus rangée dans « Terminé ». Elle attend dans sa propre colonne, entre « Révision humaine »
  et « Terminé », et passe seule dans « Terminé » quand la PR est fusionnée. La colonne est
  masquée tant qu'aucune PR n'attend, la carte y montre ses boutons de PR, et un ordre de
  colonnes déjà enregistré la reçoit sans perdre ses largeurs. Une carte sans PR ne peut pas y
  être déposée.
- **Filtre « Générée par une page »** : les cartes que crée le studio de tests, Import Design,
  le journal des modifications ou le pair programming ont leur source dans le filtre du Kanban.
- **La spec profite aussi de la boucle d'apprentissage.** Le rédacteur de spec (rapide et standard) et son critique reçoivent les leçons que la Learning Loop a tirées des builds précédents et que vous avez adoptées, comme le planificateur, le codeur et la QA les recevaient déjà. Une règle apprise ne manque donc plus à la spec qui cadre le plan (#345).
- **La boucle d'apprentissage analyse les builds avec un modèle, quel que soit le provider choisi**
  (F178). Aux patterns tirés des règles s'ajoutent ceux du modèle (Claude, Copilot, OpenAI, Gemini,
  Mistral, DeepSeek, Grok, Ollama…), vérifiés avant d'être gardés. `WORKPILOT_LEARNING_LOOP_MODEL=0`
  coupe l'appel.
- **Multi-dépôts : choisir le moteur des cartes.** Le dialogue « Multi-dépôts » demande le fournisseur, le modèle et l'effort (par phase sous « Avancé ») ; chaque carte de dépôt les reçoit comme si on les avait choisis sur le tableau. Codex, Copilot, Ollama, Mistral et les autres fournisseurs servent donc aussi aux changements multi-dépôts. Sans choix, chaque projet garde son fournisseur par défaut (#382).
- **L'assistant de premier lancement ouvre tous les fournisseurs d'IA** (F176). Une carte
  « Utiliser une autre IA » permet de configurer Codex, GitHub Copilot, Gemini, OpenCode, Ollama,
  Mistral et les autres dès le premier lancement, dans le même panneau que Réglages → Comptes. Le
  dernier écran nomme les IA connectées, ou dit qu'aucune ne l'est et propose d'en connecter une, au
  lieu d'annoncer « Configuration terminée » dans tous les cas. Le chemin clé d'API ne saute plus les
  outils de dev ni la confidentialité. Réglages → Comptes n'affiche plus « 15 fournisseur(s) en
  erreur » sur une installation neuve, et la recherche n'affiche plus `{{count > 1 ? 's' : ''}}`.
- **Un menu de gauche plus léger, et Ctrl+K trouve toutes les pages** (F181). « Outils CLI » devient
  une pastille « CLI 1/8 » en pied de menu, qui ouvre les mêmes badges : le menu gagne environ
  320 px de haut. Les lignes n'affichent plus que l'icône et le nom (le raccourci passe dans
  l'infobulle, la poignée apparaît au survol) et les noms trop longs ont été raccourcis. Le champ
  « Rechercher », `/` et Ctrl+K ouvrent la palette de commandes, qui liste désormais les 77 pages
  (et non plus 21), les trouve par leur nom, leur groupe ou un mot-clé, sans tenir compte des
  accents, et propose d'abord les pages ouvertes récemment.
- **Une Boîte à outils rangée, un Labo pour la bêta, et le menu qui s'adapte à vous** (F181). La
  Boîte à outils passe de 20 à 9 entrées : Qualité et sécurité, Accessibilité et i18n, API et
  Automatisation deviennent des pages à onglets. Les 14 pages encore en bêta sont réunies dans le
  Labo, la fiole en bas du rail, avec une phrase sur ce que fait chacune ; une page qui sort de
  bêta retrouve sa place. Quand des pages d'un espace n'ont pas été ouvertes depuis 30 jours, le
  menu propose de les masquer (rien n'est masqué d'office) ; elles restent trouvables par Ctrl K et
  se réaffichent depuis « Pages masquées ».
- **Le menu de gauche en deux niveaux : un rail d'espaces et « Mon menu »** (F181). Une colonne
  d'icônes (Mon menu, Espace de travail, Agents, Développement…) choisit l'espace, et le panneau
  à côté ne liste que ses pages. « Mon menu » réunit les pages épinglées et les 5 dernières
  ouvertes ; la première fois, il propose un menu « Essentiel » (10 pages du quotidien, vues en
  bêta masquées) ou « Complet ». Menu replié, survoler une icône liste ses pages. Glisser une
  page sur l'étoile l'épingle, et glisser une icône du rail réordonne les espaces.
- **Les worktrees des cartes terminées ne remplissent plus le disque** (F180). Quand la PR d'une
  carte est fusionnée sur la forge (GitHub, GitLab, Azure DevOps), la carte passe « Terminé » et
  son worktree et sa branche locale sont supprimés. Le bouton « Purger » du Kanban montre la place
  occupée par les worktrees des cartes terminées, archivées ou abandonnées et les supprime. Un
  worktree avec des modifications non commitées n'est jamais supprimé.

### 🐛 Corrections

- **Mistral, DeepSeek et Grok fonctionnent aussi en mode développement et sur un serveur** (F174).
  Les fonctions qui passent par ces providers (Arena, traduction, appels ponctuels), Jira et
  Azure DevOps échouaient sur « No module named 'src' » hors de l'app installée.
- **« Copier le chemin » colle directement dans l'Explorateur Windows sous WSL** : le studio de
  tests, les worktrees et les réglages du dépôt copient `\\wsl.localhost\<distro>\…` (ou `C:\…`
  sous `/mnt/c`) au lieu du chemin Linux.
- **La liste des tests générés reste lisible** : chaque test garde sa hauteur au lieu d'être écrasé
  quand la liste dépasse le panneau, et nomme le fichier ciblé au lieu de son chemin complet.
- **Premier lancement et ajout d'un projet sans impasse** (F173). L'assistant n'affiche plus
  « steps.claudeCode » ni un compte Claude « Authentifié » sans connexion, passe à l'étape suivante
  après la création d'un profil clé d'API, « Passer » saute l'étape au lieu de fermer l'assistant, et
  « Ouvrir le créateur de tâches » ouvre l'ajout de projet quand il n'y en a pas encore ;
  l'indicateur d'usage ne reste plus sur « Loading... » au premier lancement. Sur une
  machine où git ne connaît ni nom ni e-mail, « Initialiser Git » les demande au lieu d'échouer.
  Créer un projet ne demande plus de recliquer sur « Passer pour l'instant », et un projet à
  initialiser prépare git dans ses réglages sans fenêtre qui les ferme.
- **Import Design et le journal des modifications écrivent sur une branche de revue** (F180).
  « Écrire dans le projet » d'Import Design et « Enregistrer » du journal écrivaient dans le
  dossier du projet, sur la branche courante. Les fichiers du composant, `CHANGELOG.md` et les
  images collées vont maintenant sur la branche d'une carte « Code généré » en Revue humaine :
  vous relisez le diff, puis « Créer la PR ». Le chemin du journal ne peut plus sortir du projet.
- **Le pair programming code sur une branche de revue** (F180). L'agent écrivait en direct dans
  le dossier du projet. Il travaille maintenant dans le worktree d'une carte « Code généré » ; à
  la fin de la session, son travail y est commité et la carte attend votre revue, avec « Voir la
  carte » et « Créer la PR » sur la page.
- **Les tests générés arrivent sur une branche de revue, plus dans votre dossier de projet**
  (F180). Le studio de tests écrivait ses fichiers, et les paquets ajoutés aux manifestes,
  directement dans le projet, donc sur la branche courante. Chaque génération (Unitaire, E2E,
  TDD) et chaque ajout de paquets vont maintenant dans le worktree d'une carte « Code généré »
  en Revue humaine, comme une tâche du Kanban : vous relisez le diff, puis « Créer la PR ». Les
  générations suivantes rejoignent la même carte jusqu'à l'ouverture de sa PR.
- **La barre « Commande rapide » du Kanban marche avec un abonnement Claude et avec tous les
  providers** (F182). Elle échouait sur « No OAuth token found » avec un abonnement Claude
  classique et ignorait le provider choisi : la commande tournait dans le serveur backend, qui n'a
  ni la connexion du profil Claude ni le provider de l'app. Elle tourne maintenant avec le
  provider sélectionné (Claude Code, Codex, Copilot, Gemini, OpenCode, Mistral, Ollama…) et, comme
  les autres pages, sur une branche de revue : ce que la commande écrit attend sur une carte en
  Revue humaine, d'où l'on ouvre la PR, au lieu d'arriver dans le dossier du projet.
- **Supprimer un projet du serveur arrête d'abord ses agents et ses analyses** (F175). Ils ne
  continuent plus dans un dossier effacé, et sur un serveur SQLite les tâches, runs et membres du
  projet partent avec lui au lieu de rester orphelins.
- **Le studio de génération de tests fonctionne à nouveau** (F179). Les onglets Unitaire,
  Analyser, E2E et TDD échouaient sur « No agent runtime is installed », quels que soient le
  provider et la stack, et un scénario E2E d’un projet C#, Java ou Go ne s’écrit plus en `.js`.
- **Les modules et les Paramètres reprennent les couleurs du thème choisi** (F172). La charte UI
  imposait son propre orange et ses propres couleurs d'état : sur Ocean, Forest, Neo ou Lime, la
  barre latérale avait la couleur du thème et l'écran à côté était orange. L'accent, les états
  (succès, alerte, erreur, info) et les surfaces suivent maintenant le thème actif, en clair comme
  en sombre ; Import Design, le studio de génération de tests et le canvas Visuel vers Code aussi
  (le canvas garde ses préréglages de couleurs, « Thème de l'app » devient celui par défaut).

### 🔒 Sécurité

- **Les dernières alertes de dépendances sont corrigées.** oauthlib passe en 4.0.1 (CVE-2026-49272) côté Python ; glob et minimatch passent sur leurs versions corrigées (14.0.2+ et 11.0.1+) dans l'application de bureau et l'application mobile ; le renderer archify embarqué ne déclare plus fast-uri 3.1.5, et le script de vendoring garde ce plancher quand on le relance. Reste deepmerge (faible, outillage Jest du mobile) : aucune version corrigée n'existe encore.
- **L'URL du webhook Slack ou Teams est stockée chiffrée** (F177). Elle n'est plus gardée en clair
  dans l'interface et n'apparaît plus dans la liste des processus. Une URL déjà enregistrée est
  reprise automatiquement à la première ouverture de l'écran Team Bot.

### 🛠️ Qualité

- **Une version se publie dès que son tag est posé** (F171). Les builds de la release ne tentent
  plus de créer eux-mêmes la release GitHub, ce qui les faisait tous échouer quand le tag lançait le
  workflow.

### 📚 Documentation

- **Un README plus soigné, avec le nouveau menu**. Les captures sont refaites avec le menu en
  espaces (« Mon menu », rail, Labo) et présentées dans un cadre de fenêtre sur fond dégradé. Les
  schémas « Fonctionnement » et « Architecture » sont redessinés (cartes, icônes de l'app, légende),
  en anglais et en français, et suivent le thème clair ou sombre de GitHub.
- **L'atlas d'architecture et le README racontent les changements du 9 novembre**. L'atlas
  (`docs/audit/WorkPilot-architecture.html`) gagne un tableau « Ce qui a changé le 9 novembre
  2026 » lisible sans bagage technique, la carte « Code généré » dans sa topologie et les PR du jour
  en tête de ses évolutions. Le README, en anglais et en français, dit que tout code écrit par une
  page passe par une branche et une PR relue, et présente la purge des worktrees, les nouveaux diffs,
  la commande rapide, le menu en espaces avec son Labo et l'assistant de premier lancement pour
  tous les providers.
- **Des schémas dans le README à la place des flèches en texte**. Le fonctionnement (planifier,
  construire et contrôler, prouver et livrer) et l'architecture (machine, services, mode équipe)
  sont dessinés en diagrammes Mermaid, affichés par GitHub, en anglais et en français ; l'arbre des
  dossiers devient un tableau.
- **Le README existe en anglais et en français, avec des captures aux couleurs du thème**.
  `README.fr.md` reprend tout le README anglais, et chacun renvoie vers l'autre en tête de page.
  Les captures sont refaites après le passage de la charte UI aux couleurs du thème actif. À chaque
  version, le tableau de téléchargement des deux fichiers est mis à jour, chacun dans sa langue.
- **Un README plus court et rangé, avec des captures à jour**. Le README tient en une page : ce que
  fait l'app, téléchargement, démarrage rapide, fonctionnement, visite en captures, features en bref,
  providers, documentation. Le détail part dans `docs/FEATURES.md`, `docs/INSTALLATION.md` et
  `docs/ARCHITECTURE.md`. Toutes les captures sont refaites, dont celle des terminaux d'agents qui
  montrait encore l'ancienne interface ; le wiki reçoit la nouvelle.

---

## 1.4.0 - Une seule charte UI, et les grosses tâches se découpent en petites PR

Tous les modules et toutes les pages de paramètres adoptent une seule charte, celle de « Visuel
vers Code ». Une tâche trop grosse se découpe d'elle-même en petites PR qui se reconnaissent à leur
couleur et avancent seules à chaque fusion. Visuel vers Code vérifie toute l'architecture, Import
Design, le studio de génération de tests et Docs et dérive sont refaits, et les analyses couvrent
toutes les stacks (.NET, Java, Go, Rust, PHP, Ruby, Dart, Swift…).

### ✨ Nouveautés

- **Le plafond du découpage automatique suit le type de tâche** : 100 lignes à relire pour un correctif urgent, 200 pour une correction de bug ou une mise à jour de version, 300 pour un refactoring, 400 pour une feature, des tests ou de la doc ; les investigations, spikes et tâches d'exploitation ne sont jamais découpées. Les valeurs suivent les études sur la revue de code (au-delà de 200 à 400 lignes ou d'une heure, le relecteur trouve moins de défauts) et se règlent par type dans les paramètres du projet. Le code compte pleinement, les tests et la doc pour moitié, les lockfiles et fichiers générés pas du tout, sur toutes les stacks. Nouveau type de tâche « Mise à jour de version » (framework, SDK, dépendances, labels Dependabot et Renovate).
- **Les parts d'une tâche découpée avancent seules après chaque fusion** : quand la PR d'une part est fusionnée (GitHub, GitLab ou Azure DevOps), la part passe en terminé, les parts empilées dessus sont rebasées sur la branche de base et leur PR reciblée, puis la part suivante démarre. Après la QA, la carte mesure aussi son diff réel en lignes à relire et affiche « 620 / 400 lignes » quand elle dépasse le plafond de son type.
- **Les PR d'une tâche découpée se reconnaissent d'un coup d'œil** : toutes les parties d'un même groupe ont la même couleur et la marque « Partie 2/4 · OAuth Google » sur le Kanban et sur l'app mobile, et un clic sur cette marque n'affiche que le groupe. Sur GitHub et GitLab, leur PR porte le préfixe `[OAuth Google 2/4]`, le label `groupe/<tâche>` dans la couleur du groupe et une section « Groupe de PR » qui liste les autres parties et dit laquelle relire d'abord ; sur Azure DevOps, le préfixe et la section.
- **Une tâche trop grosse se découpe toute seule en petites tâches** : après la planification, si le plan dépasse le plafond de lignes modifiées (400 par défaut, réglable dans les paramètres du projet et surchargeable sur chaque tâche), la tâche devient plusieurs cartes « Partie k/N », une PR chacune, plus simples à relire. Les parties indépendantes démarrent en parallèle ; une partie qui dépend d'une autre démarre dès que celle-ci a passé la QA, empilée sur sa branche. Tous les fournisseurs et toutes les stacks, puisque seul le plan est lu.
- **Chaque CLI de la barre « Outils CLI » se met à jour d'un clic** : OpenCode, Antigravity, pi, Gemini CLI et Hermes rejoignent Claude Code, Copilot et Codex. La carte compare la version installée à la dernière publiée (registre npm, versions GitHub), affiche « Mise à jour disponible » et un bouton « Mise à jour » qui passe par le canal qui possède la copie lancée (npm et son préfixe, pnpm, Homebrew, l'outil de mise à jour du CLI comme `opencode upgrade`, `agy update` ou `hermes update`, sinon le script d'installation de l'éditeur), puis se rafraîchit. Windows, macOS et Linux (WSL compris). Antigravity ne publiant pas de numéro de version, sa carte propose « Mettre à jour si besoin ».
- **Docs et dérive refait** dans le style de « Visuel vers Code » : couverture du projet par langage et fichiers à documenter en priorité, symboles du fichier choisi, commentaires de doc proposés dans la convention de chaque langage (XML doc, KDoc, rustdoc, godoc, Swift, JSDoc, docstring…), README de dossier ; le détecteur de dérive montre ses trois étapes, filtre les écarts par sévérité et explique chaque correction. Les deux onglets lisent désormais tous les langages (.NET, Java, Kotlin, Go, Rust, Swift, PHP, Ruby, Dart, C/C++, TypeScript, Python) et la dérive ignore changelogs, skills, modèles et dossiers générés.
- **Charte UI commune** : les composants partagés de cette refonte (scène, colonnes, cartes à rail, chips, bouton principal, barre de commande) servent de base aux prochains modules et aux pages de réglages.
- **Import Design refait** : une image devient des composants de la stack du projet (React, Next.js, Vue, Nuxt, Angular, Svelte, Blazor, HTML, React Native, Flutter, SwiftUI, Jetpack Compose, .NET MAUI, WPF/WinUI, Avalonia), détectée automatiquement. Les six étapes s'affichent en direct, les zones reconnues sont dessinées sur l'image, et les fichiers relus s'écrivent dans le projet en un clic ou partent en tâche Kanban.
- **L'encart « Plateformes mobiles » s'adapte au projet** : sur un projet qui a déjà une application (Flutter, React Native/Expo, .NET MAUI, Kotlin Multiplatform, Capacitor, Android ou iOS natif), il nomme le framework détecté et grise la plateforme absente. Sur un projet sans application (Web API .NET, service Go, CLI…), un préambule prévient que cocher Android ou iOS ajoute au tableau les tâches d'installation du framework et de création de l'application, puis une tâche par plateforme, et que la tâche attendra qu'elles soient terminées. Le framework proposé suit les stacks du dépôt (.NET → MAUI, React → Expo, Angular/Vue → Capacitor, Java/Kotlin → KMP…). En local comme en mode serveur.
- **L'agent de génération de tests passe en studio** (F161) : même mise en page que Visuel vers Code, avec la cible à gauche, le déroulé en quatre étapes reliées au centre (état en direct, clic pour ouvrir le résultat de l'étape) et le code écrit en direct à droite, avec onglets Tests, Gaps et Stack. Le TDD propose 14 langages plus celui du projet, et les gaps d'une analyse se transforment en tests unitaires en un clic. Go, Rust, PHP, Ruby, Dart/Flutter, Swift, Kotlin, C et C++ sont détectés avec leurs frameworks et bibliothèques de test.
- **Charte UI sur le groupe Agents** : Bureau Pixel (barre d'outils), Auto-Guérison, Banc de rejeu, Bounty Board, Coach personnel d'agent et Compagnon en direct adoptent le style de « Visuel vers Code » : en-tête à kicker, compteurs, onglets en pastilles, cartes à rail colorées par sévérité, barre de commande en bas avec un seul bouton principal. Les Terminaux gardent leur grille. Le Bounty Board ne plante plus quand la liste des manches précédentes revient vide.
- **Charte UI sur le groupe Développement** : Pair Programming IA, Revue de code, Dette technique, Refactoring, Guide et Kit d'intégration, Détective de tests instables, Profileur de performance, Traduction inter-langages et le Bac à sable de code adoptent le style de « Visuel vers Code » (colonnes, cartes à rail, barre de commande en bas, un seul bouton principal). Les boutons, cartes et badges partagés prennent automatiquement l'accent et les tons de la charte dans un module, ce qui fait disparaître les boutons lime ou bleus isolés.
- **Revue de code et Refactoring réparés et multi-langages** : les deux vues ne joignaient jamais le backend dans l'application (URL relative) ; elles passent maintenant par le processus principal. Les code smells (méthode longue, trop de paramètres, imbrication profonde, nombre magique, doc manquante, duplication…) et les règles de revue couvrent .NET, Java, Kotlin, Scala, Go, Rust, Swift, PHP, Ruby, Dart, C/C++ et JS/TS en plus de Python ; le Refactoring détecte le langage de l'extrait ou le laisse choisir.
- **Charte UI sur le groupe Explorer** : Analyses, Contexte du projet (index, mémoires, Maillage de contexte, Extraits contextuels), Visualiseur d'architecture, Idéation et Boucle d'apprentissage adoptent le style de « Visuel vers Code » : en-tête à kicker, onglets en pastilles avec compteurs, cartes à rail colorées par type d'idée, barre de commande en bas, un seul bouton principal. L'Idéation gagne l'onglet « Qualité du code » qui manquait et ses descriptions de types sont traduites ; le Maillage de contexte retrouve ses accents en français. La page qui ouvre un outil en fenêtre (Extraits contextuels, Arène, Estimation…) suit aussi la charte.
- **Charte UI sur le groupe Git & Intégrations** : Arbres de travail, Chirurgien d'historique Git, Git en langage naturel, Rayon d'impact, Prédicteur de conflits et Déclencheurs CI/CD adoptent le style de « Visuel vers Code » : en-tête à kicker, colonnes à kicker, cartes à rail colorées par gravité ou statut, barre de commande en bas avec un seul bouton principal. Le **Rayon d'impact** suit désormais les dépendants dans toutes les piles : C#, F#, VB, Razor, Java, Kotlin, Scala et Swift par nom de type, PHP (`use` à antislash), C/C++ (`#include`), Vue, Svelte, Dart, et reconnaît les fichiers de test de chaque pile (`*Tests.cs`, `*_test.go`, `*Spec.kt`, `test_*.py`, `*.spec.ts`…). Des cibles introuvables sont signalées au lieu d'un score vide.
- **Charte UI sur le groupe Planification** : Feuille de route, Analytiques, Coûts et estimation (avec Estimation intelligente), Approbation des specs, Journal des modifications, Train de release, Profileur carbone et Snapshots d'environnement adoptent le style de « Visuel vers Code » : en-tête à kicker, onglets en pastilles, chiffres clés en cartes, colonnes et barre de commande en bas avec un seul bouton principal. Priorités, statuts du Kanban de la feuille de route et statuts des tâches sont traduits ; l'Estimateur de coûts affiche un état vide au lieu d'une page blanche, et la page Snapshots ne plante plus quand la liste arrive vide.
- **Train de release et Snapshots d'environnement sur toutes les piles** : le train de release trouve les services .NET (C#, F#, VB), Java et Kotlin (Maven, Gradle), Go, Rust, Dart/Flutter, PHP, Ruby, Elixir et Swift en plus de npm et Python ; un snapshot relève les chaînes d'outils de chaque pile (dotnet, java, mvn, gradle, go, rustc, php, ruby, dart, flutter, swift, bun, deno…) et leurs lockfiles, et le rejeu (Dockerfile, shell Nix, script de vérification) installe exactement ces outils au lieu de Node et Python seuls. Les mots de passe glissés dans les URL des variables d'environnement sont désormais masqués dans le snapshot.
- **Charte UI sur les paramètres** : la fenêtre des paramètres adopte le style de « Visuel vers Code » : en-tête à kicker, fond à trame de points, navigation par groupes colorés où la page ouverte prend la couleur de son groupe, et chaque page s'ouvre sur le nom de son groupe, son titre et sa description. Les messages d'erreur, de succès et d'information deviennent des encadrés de la charte, et le bouton d'enregistrement prend la couleur d'accent.
- **Paramètres traduits** : les groupes de la navigation (« Intégrations & Connexions », « Système & Maintenance »…) et une douzaine de pages s'affichaient en français même avec l'interface en anglais.
- **Cartes de fournisseurs IA en thème sombre** : les badges « CLI authentifiée », « Local » et la clé masquée n'apparaissent plus en blanc sur fond sombre.
- **Charte UI sur la boîte à outils (seconde moitié)** : Générateur de pipeline CI, Migration de code, Vérification des notebooks, Veille des contrats d'API, Aperçu des changements, Agent navigateur (navigateur, tests, régression visuelle), Bot d'équipe, Mode hors ligne, Émulateur d'application, Optimiseur de prompt, Assistant vocal et API Studio adoptent le style de « Visuel vers Code » : en-tête à kicker, onglets et filtres en pastilles, chiffres clés en cartes, résultats en cartes à liseré coloré, un seul bouton principal.
- **Outils de la boîte à outils sur toutes les piles** : le générateur de pipeline détecte PHP, Ruby, Dart/Flutter, Swift, Elixir, Angular, Nuxt, Svelte, NestJS, Express et les solutions .NET, propose Azure Pipelines et Bitbucket en plus de GitHub Actions, GitLab CI et CircleCI ; la vérification des notebooks lit aussi les notebooks .NET Interactive (.dib), Quarto (.qmd) et R Markdown (.Rmd) ; la veille des contrats trouve GraphQL, Protobuf et les specs OpenAPI rangées dans un dossier `api/`, `contracts/`… ; l'agent navigateur lance aussi les tests Cypress, .NET, JUnit (Maven/Gradle), Go, RSpec et PHPUnit/Dusk ; API Studio scanne les routes Laravel, NestJS et Spring en Kotlin.
- **Migration de code honnête** : la page n'annonce plus une migration « en file d'attente » qui ne s'exécutait jamais. Elle analyse le projet, montre la pile source détectée et le plan, puis crée une tâche Kanban qui fait la migration dans un worktree isolé.
- **Charte UI sur la boîte à outils (première moitié)** : Aperçu MCP, Marketplace MCP, Marketplace de plugins, Gardien de régression, Garde d'injection, Collecteur de preuves de conformité, Sentinelle de dépendances, Garde-fous des agents, Analyse d'accessibilité et Analyse i18n adoptent le style de « Visuel vers Code » : en-tête à kicker, onglets et filtres en pastilles, chiffres clés en cartes, résultats en cartes à liseré coloré, un seul bouton principal. Le Gardien de régression montre le test généré sous chaque incident ; les règles des garde-fous se choisissent en pastilles (Autoriser, Avertir, Refuser, Demander une approbation) et le même éditeur sert dans les Paramètres.
- **Analyses de la boîte à outils sur toutes les piles** : le Gardien de régression écrit le test dans le framework de la pile en cause (pytest, Jest, Vitest, Mocha, JUnit 5, TestNG, xUnit, NUnit, Go, cargo, PHPUnit, RSpec, Dart, XCTest) au lieu de pytest seul ; l'analyse i18n lit les catalogues .NET (RESX), Flutter (ARB), Angular (XLIFF), Android, iOS, gettext, Java, Rails et Laravel en plus du JSON, et repère le texte en dur dans Razor, XAML, Flutter, SwiftUI et Compose ; l'analyse d'accessibilité couvre Razor/Blazor, Blade, Twig, ERB et Astro ; le collecteur de conformité reconnaît Azure Pipelines, Jenkins, Bitbucket, CircleCI, Renovate et CodeQL.
- **Sentinelle de dépendances honnête** : elle n'affiche plus des paquets et une vulnérabilité d'exemple identiques pour tous les projets, mais ce que la garde des dépendances vérifie réellement à chaque tâche.
- **Charte UI sur l'espace de travail** : Tableau de bord, Contrôle de Mission, Historique des sessions, Agent de Replay, Débogueur d'agent et Fonctionnalités avancées adoptent le style de « Visuel vers Code » : en-tête à kicker, chiffres clés en cartes à liseré, barres par statut, modèle et fournisseur, onglets en pastilles, un seul bouton principal. Le débogueur liste les sessions en cartes (exécution en cours ou dernière exécution, agent, points d'arrêt) au lieu d'une liste déroulante, et les outils se choisissent en pastilles. Le tableau Kanban garde son propre dessin.
- **Erreurs lisibles quand le backend local ne répond pas** : l'Historique des sessions et l'Agent de Replay n'affichent plus « Unexpected end of JSON input » ou « Unexpected token '<' », mais un message qui dit de démarrer le backend puis d'actualiser.
- **Débogueur d'agent** : la page ne plante plus (écran noir) quand la liste des sessions revient vide ou incomplète.
- **Visuel vers Code vérifie la cohérence de toute l'architecture** (F162) : chaque paire de blocs est un lien attendu ou est refusée avec sa raison et le bloc à intercaler (une flèche à l'envers se retourne d'un clic), les technologies incompatibles sont signalées (Celery sur Kafka, PostgreSQL dans une app mobile…), et le panneau « Points d'attention » relève base partagée entre microservices, appels en cycle, gateway contournée ou file sans consommateur. Ces points partent aussi dans la spécification de build.

### 🐛 Corrections

- **Import Design fonctionne de bout en bout** : le runner ne plante plus au démarrage, la vision passe par l'abonnement Claude quand aucune clé n'est configurée, et un résultat d'exemple est signalé comme tel au lieu d'être présenté comme une analyse.
- **L'application mobile d'un monorepo est retrouvée** : la détection n'explorait que le dernier dossier de chaque niveau, si bien qu'une app dans `apps/mobile/` passait inaperçue dès qu'un dossier comme `tests/` venait après `apps/`. Une carte serveur « Android seulement » construisait aussi toutes les plateformes : la cible choisie atteint maintenant le run du serveur.
- **« Python environment not ready »** ne bloque plus les analyses (Détecteur de dérive, Accessibilité, Conformité, Dette technique, Rayon d'impact… 30 modules) ouvertes avant la première tâche : l'environnement Python se prépare à la demande. L'onglet Documentation, qui n'atteignait jamais le backend dans l'application, fonctionne.
- **Les pages qui lancent Python se réparent seules** (F170) : quand le Python qui avait créé l'environnement du backend a été mis à jour ou désinstallé, la Feuille de route, le Débogueur d'agent et les autres analyses échouaient avec « Python environment not ready: Unhandled error. ('Python not found in virtual environment') ». L'environnement est maintenant reconstruit automatiquement, et une vraie panne affiche sa cause. La barre des phases de la Feuille de route n'affiche plus de « ) » parasites.
- **Génération de tests : les bonnes réponses pour chaque stack** (F161) : le résultat d'une analyse de couverture s'affiche enfin, la cible de couverture est transmise au modèle, le framework est lu dans les manifestes du langage du fichier (un projet C# avec un `package.json` n'obtient plus Vitest), l'E2E et le TDD ne retombent plus sur TypeScript ou Python et écrivent des chemins dans l'extension du langage.
- **Visuel vers Code relie toutes les architectures cohérentes** (F160) : Backend → Worker, Worker → base de données, push temps réel vers les clients, webhooks, CDC, monitoring depuis n'importe quel bloc… La relation se choisit dans une liste adaptée aux deux blocs et à leurs stacks (gRPC, SignalR, MassTransit, EF Core, AMQP, FCM / APNs…) ou se saisit librement, et une connexion imprévue peut être forcée avec « Relier quand même ».

### 🛠️ Qualité

- **Alertes CodeQL de la release corrigées** : Import Design écrit un fichier relu et lit un manifeste par un seul descripteur (plus de vérification puis écriture séparées), les identifiants d'éléments importés sont nettoyés avant d'entrer dans le journal, et une condition morte disparaît des paramètres des fournisseurs.
- **Les PR empilées se fusionnent seules, dans l'ordre.** Une PR vers `develop` avec l'auto-merge
  activé attend celles sur lesquelles elle est construite ; le pilote de pile fusionne ensuite
  `develop` dedans, résout les conflits (Claude Code pour ceux qu'une règle ne tranche pas) et ne la
  fusionne qu'une fois tous ses checks verts, alors que l'auto-merge GitHub fusionnait dès la fin
  des conflits, sans attendre la CI.

### 📚 Documentation

- **Le README et ses guides disent ce que fait le code** (F159) : providers réels (sans Azure OpenAI, avec Mistral, DeepSeek, Windsurf, les modèles locaux et les CLI d'agent), variables d'environnement lues (`GROK_API_KEY`, pas `ANTHROPIC_API_KEY`), Node.js 22.12+ et pnpm 12.16.1, installation native de Claude Code, `pnpm verify` comme porte complète, détection de stack et Import Design pour toutes les stacks, vues expérimentales signalées, chemins `.workpilot/specs/` et `.workpilot/worktrees/tasks/` dans le guide CLI.

### 🧹 Maintenance

- **Node.js 22.12 minimum déclaré** (F159) : `engines.node` passe de `>=20.0.0` à `>=22.12.0` dans les deux `package.json`, la version que Vitest 5 exige et que la CI utilise ; le job d'audit npm tourne aussi sur Node 22. Les badges et liens Discord / YouTube hérités du projet amont sont remplacés par les releases, les Discussions et le wiki du dépôt.

---

## 1.3.4 - L'équipe partage tout, et l'agent se guide en cours de route

Le mode serveur devient complet : toutes les features se partagent dans l'équipe, en direct,
avec organisations isolées, rôles et groupes, et une app iPhone et Android le suit. L'agent se
guide pendant qu'il travaille (message, élément pointé dans l'aperçu, commentaire de ligne), et
la PR arrive avec plus de preuves : portes après la QA, Agent Trace, dossier de provenance,
traçabilité des exigences, vidéo et comparaison avec la branche de base.

### ✨ Nouveautés

- **Les conventions d'un projet atteignent tous les fournisseurs.** OpenAI, Grok, DeepSeek, Mistral, OpenRouter, Gemini par API et les modèles locaux reçoivent désormais le `AGENTS.md` du projet (ou son `CLAUDE.md`) dans leur prompt système, comme Claude et les CLI le lisaient déjà. Le fichier est nettoyé, plafonné à 32 Kio, écarté s'il ressemble à une injection, et suit le même réglage « Inclure CLAUDE.md » du projet. Les fichiers d'instructions du dépôt WorkPilot ont aussi été refondus : une seule copie des règles critiques, environ 6 Ko chargés par session Claude au lieu de 42.
- **Savoir quelle part de la PR vient de l'IA.** Après chaque session, WorkPilot enregistre quelles
  lignes l'agent a écrites et avec quel modèle, au format ouvert Agent Trace (`agent-trace.jsonl`
  dans le dossier de la tâche), quel que soit le fournisseur, CLI compris. Les lignes que vous
  aviez modifiées entre deux sessions restent les vôtres. La vue des fichiers modifiés affiche la
  part de l'IA par fichier, et le corps de la PR en donne le résumé. Aucun prompt ni code n'est
  enregistré.
- **Mesurer une règle avant de l'adopter.** Le banc de rejeu prend une règle candidate (tapée, ou
  partie d'une règle apprise des revues) et rejoue chaque moteur sans elle puis avec elle. La
  carte du passage dit combien de cartes chaque variante réussit et si la règle en fait échouer
  une : une seule régression suffit à la déconseiller. Rien n'est adopté d'après ce score, et ces
  rejeux n'entrent pas dans le tableau des modèles.
- **Correctif.** Les copies du banc lisaient les règles adoptées du dossier personnel au lieu des
  leurs.
- **Les tableaux du serveur d'équipe dans tes apps d'IA**. En mode serveur, Réglages → Intégrations
  → « Accès MCP au serveur » crée un jeton d'accès personnel (lecture seule ou lecture et écriture,
  30 à 365 jours, révocable) et donne l'entrée à coller dans Claude Code, Codex, Gemini CLI,
  GitHub Copilot, Cursor, Claude Desktop, Windsurf ou OpenCode. L'app joint `<serveur>/mcp` en
  HTTP, voit les projets de l'organisation que tu vois, et ne va jamais plus loin que ton rôle. Le
  jeton n'ouvre que `/mcp` : il ne peut appeler aucune autre route du serveur.
- **Le serveur MCP du Kanban en dit plus**. `workpilot-board` lit maintenant la spec et le plan d'une
  carte (`get_spec`), la roadmap (`get_roadmap`) et les idées d'Ideation (`list_ideas`), et corrige le
  titre ou la description d'une carte tant que rien n'a démarré (`update_card`). Une carte et la
  roadmap sont aussi des ressources MCP (`workpilot://cards/…`, `workpilot://roadmap`), à joindre
  dans Claude Code, VS Code ou Cursor.
- **Le Kanban dans tes autres apps d'IA, en un clic**. Réglages du projet → Intégrations →
  « Utiliser depuis d'autres apps » ajoute le serveur MCP `workpilot-board` du projet à Claude Code,
  Codex, Gemini CLI, GitHub Copilot (CLI et VS Code), Cursor, Claude Desktop, Windsurf ou OpenCode,
  sans taper de chemin Python. Chaque app voit si son entrée est à jour ; une app non installée ou
  un fichier illisible donne la configuration à coller. Le reste du fichier de l'app n'est pas
  touché, et une copie est gardée la première fois.
- **Outils CLI triés.** Le panneau « Outils CLI » de la barre latérale liste d'abord les CLI
  installés (une mise à jour disponible compte comme installé), puis ceux à installer, chaque
  groupe par ordre alphabétique. Un CLI qui vient d'être installé remonte de lui-même.
- **Migrer un projet .NET 8 ou 9, une version à la fois.** Les procédures officielles de l'équipe
  .NET pour 8 → 9 et 9 → 10 rejoignent celle de 10 → 11, revues et complétées (C# 14, EF Core 9 et
  10, NuGet en HTTP, `DefineConstants`, mutex nommés). Une tâche Kanban qui nomme .NET 9, 10 ou 11
  (ou C# 13, 14, 15) reçoit chaque étape entre la version du projet et celle demandée, dans
  l'ordre ; le planificateur prévoit une étape par version, la QA vérifie la cible. .NET 8 et 9 ne
  sont plus supportés après le 10 novembre 2026 : les procédures le rappellent et visent .NET 10
  (LTS) par défaut. Les commandes `/migrate-dotnet8-to-dotnet9` et `/migrate-dotnet9-to-dotnet10`
  apparaissent dans la palette des seuls projets concernés.
- **Migrer vers .NET 11 et C# 15.** Une tâche Kanban qui demande de passer un projet .NET 10 à
  .NET 11 (ou à C# 15) suit désormais la procédure de migration de l'équipe .NET, revue et mise à
  jour jusqu'à la RC2 : changements cassants du compilateur, des bibliothèques, d'Extensions,
  d'ASP.NET Core, d'EF Core, du SDK, du runtime et de MAUI, avec ce qu'il faut chercher dans le code
  pour chacun. Le planificateur, le codeur et la QA la lisent, avec tous les providers ; un projet
  déjà en .NET 11 garde sous la main le guide d'adoption de C# 15 (unions, hiérarchies `closed`…).
  La commande `/migrate-dotnet10-to-dotnet11` apparaît dans la palette des seuls projets .NET 10
  ou 11. Les autres stacks ne paient rien.
- **Les projets WPF, WinUI, MAUI et à `Directory.Build.props` reçoivent les skills .NET** (F158) :
  la version cible `net10.0-windows`, `net11.0-android`… et celle d'un `Directory.Build.props` sont
  maintenant lues, et `netstandard2.0` n'est plus pris pour « .NET 2.0 ».
- **Les vues expérimentales disent qu'elles sont en phase bêta.** Au survol d'une entrée du menu, l'info-bulle affiche « Nom de la vue (phase bêta) », et la fiole précise ce que cela signifie. En haut de la page, un bandeau « Fonctionnalité en phase bêta » rappelle que la vue peut encore changer ou disparaître. Le bouton de la barre latérale devient « Masquer les vues en bêta ».
- **Revue guidée : le diff dans l'ordre du plan.** Dans la revue d'une tâche, le bouton « Revue
  guidée » montre les changements sous-tâche par sous-tâche, chacune avec ce qu'elle a changé
  elle-même et la description du planner comme explication, puis les commits qu'aucune sous-tâche
  n'a enregistrés (correction QA, commit à la main) et ce qui n'est pas encore commité. Les fichiers
  hors plan, le code déplacé d'un fichier à l'autre et les remarques QA sont signalés sur leur
  fichier. L'état « vu » est conservé par tâche et se perd quand le patch change, après une
  correction. Aucun modèle n'est appelé.
- **Hermes Agent 0.23.0.** La pack de skills Hermes suit désormais les versions publiées
  d'Hermes (aujourd'hui v0.23.0) et non plus sa branche principale, où une version canary
  sort chaque jour. Le diagnostic Hermes (barre latérale « Outils CLI » et panneau de tâche)
  affiche la version installée et propose `hermes update` en dessous de 0.23.0.
- **La persona s'applique aussi aux sessions Hermes déjà ouvertes.** Après « Installer
  SOUL.md », WorkPilot demande à Hermes (`hermes sessions refresh-prompts`) de recharger le
  prompt de ses sessions en cours à leur prochain tour, historique conservé.
- **Verrouiller un skill Hermes gardé.** Quand vous gardez des skills appris par Hermes, le
  panneau donne la commande `hermes curator lock <skill>` pour qu'Hermes ne réécrive plus la
  version que vous avez relue.
- **`wait_for_card` montre sa progression.** Le serveur MCP du Kanban envoie la colonne et les
  sous-tâches d'une carte pendant qu'il l'attend, ce qu'Hermes 0.23 (et Claude Code) affichent.
  L'entrée Hermes écrite par l'app porte un délai de quatre heures au lieu des 300 secondes
  par défaut d'Hermes ; une entrée plus ancienne apparaît « à mettre à jour ».
- **Hermes Agent peut piloter le Kanban** : « Utiliser depuis d'autres apps » (réglages du projet → Intégrations) l'ajoute en un clic, comme Claude Code ou Cursor. L'entrée est écrite dans `~/.hermes/config.yaml` (`HERMES_HOME` respecté) sans toucher aux commentaires du fichier.
- **Hermes Agent apparaît dans le panneau « Outils CLI » de la barre latérale** : son état (prêt, partiellement configuré, non installé), chaque condition avec la commande qui la remplit, le nombre de skills qui attendent votre relecture et l'installation de la persona `SOUL.md`. Rien n'est installé ni approuvé à votre place, et le badge n'apparaît pas en mode serveur.
- **Les revues de PR et le tri d'issues GitHub alimentent aussi la boucle d'apprentissage Hermes** : à la fin d'une revue, d'une revue de suivi ou d'un tri d'issues, les skills qu'Hermes a écrites entre-temps sont déposées dans `skills/_proposed/` pour relecture, comme après un build. Rien n'est activé sans relecture, et le mode serveur n'est pas concerné.
- **Les procédures de débogage d'Hermes servent aux tâches de type bug, hotfix et investigation** : la phase qui reproduit le bug propose désormais la méthode de débogage systématique d'Hermes et ses guides de débogueur Python (pdb, debugpy) et Node.js (`--inspect`), que l'agent ouvre quand le cas se présente. L'investigation propose la méthode systématique. Les procédures de WorkPilot restent celles qui sont suivies.
- **Les revues deviennent des règles du projet, si tu les adoptes**. Un commentaire de revue que
  le suivi de PR a corrigé, ou le retour donné en rejetant un plan, apparaît comme règle candidate
  dans la Boucle d'apprentissage. Tu l'adoptes dans ta formulation ou tu l'écartes ; une règle
  adoptée est donnée à chaque phase des builds suivants, et rien n'y entre sans toi.
- **Un second moteur relit la tâche avant la pull request**. Dans les réglages du projet, choisis
  un autre fournisseur et un modèle : après la QA, il relit le diff au regard de la spec et de
  l'objectif. S'il signale un problème bloquant, la PR est retenue et la carte le montre ; tu
  corriges, ou tu la crées quand même. Une réponse illisible ne vaut jamais un accord.
- **Le banc recommande un moteur par type de carte**. Pour les corrections de bug, les features ou
  les autres types de carte de ton projet, le banc de rejeu indique le moteur (fournisseur, modèle,
  effort) le moins cher parmi ceux qui résolvent presque aussi bien que le meilleur, avec son taux,
  ses cartes et son coût moyen. L'étape moteur d'une carte te le propose ; il ne s'applique que si
  tu cliques sur « L'utiliser ».
- **Les vues MCP Apps s'affichent aussi avec Claude**. Quand un serveur MCP que tu as ajouté au
  projet joint une vue à un outil, le panneau de tâche la montre maintenant aussi pour les tâches
  construites avec Claude, plus seulement avec les autres fournisseurs.
- **Le Kanban se pilote depuis le terminal**. Le serveur MCP `workpilot-board` donne à Claude
  Code, Codex ou Gemini CLI les cartes d'un projet : les lister, en lire une, en ajouter une au
  backlog, attendre qu'une carte soit prête pour ta revue. Lancer un build, approuver un plan et
  fusionner restent à toi, sur la carte. Pour Claude Code :
  `claude mcp add workpilot-board -- python <WorkPilot>/apps/backend/runners/board_mcp.py --project-dir <projet>`.
- **Les tests d'abord pour une Web API ASP.NET Core**. Active « Tests d'intégration d'abord » dans
  les réglages du projet : une fois le plan approuvé, les critères d'acceptation de la spec sont
  écrits en tests d'intégration avant tout code. S'ils échouent comme prévu, `dotnet test` devient
  l'objectif de la tâche, ces tests sont protégés, et le build se termine quand ils passent.
- **Les PR des autres reçoivent une revue en brouillon**. Dans Réglages › projet › Automatisations,
  une règle « Quelqu'un d'autre ouvre une PR GitHub » lance la revue IA de GitHub PRs sur chaque
  nouvelle PR qui n'est ni la tienne ni celle d'un bot, éventuellement vers une seule branche. La
  revue n'est jamais publiée par la règle et personne n'est assigné : elle t'attend dans GitHub PRs.
  Une revue par PR, 3 par jour par défaut.
- **Un scénario de vérification web écrit sur la carte**. Sous la boucle de vérification, une carte
  peut lister en langage naturel les étapes qui prouvent le changement sur une app web, une par
  ligne. La vérification les suit dans le navigateur avec Playwright, prend une capture après chaque
  étape et joint la trace Playwright à la carte (onglet Vérification). Une étape échouée fait
  échouer la vérification, et un scénario qui n'est pas allé au bout n'est jamais compté comme un
  succès.
- **Plus de fenêtres système grises : les confirmations et les erreurs s'affichent dans l'interface de l'app.** Supprimer un fournisseur ou un modèle local demande confirmation dans une boîte au thème de l'app, et les erreurs de connexion d'un profil s'affichent en notification. La barre de commande rapide du Kanban montre enfin le résultat d'une commande réussie (elle ne l'écrivait que dans la console) et confirme la création d'une tâche.
- **Les CLI manquants s'installent en un clic.** Dans la barre latérale, « Outils CLI », OpenCode, Antigravity, pi et Gemini CLI affichent un bouton « Installer » quand ils ne sont pas trouvés : WorkPilot les télécharge et les installe avec la méthode officielle de l'éditeur (le paquet npm quand il existe et que Node.js est assez récent, sinon le script d'installation de l'éditeur), sous Windows, macOS et Linux, WSL compris. Sous Linux, un préfixe npm global non inscriptible est réessayé dans `~/.local`, et sous WSL un npm Windows (`/mnt/c/…`) n'est jamais utilisé. La connexion reste celle de chaque CLI : on se connecte une fois dans un terminal.
- **Un Kanban plus léger et plus lisible.** Chaque colonne garde sa couleur, mais la porte autrement : un point devant son nom, une teinte légère sur la colonne et un liseré sur ses cartes, au lieu d'une bordure épaisse sur chaque boîte. Les en-têtes n'affichent plus que le nom et le compteur ; les outils (sélection, limite d'encours, glisser, menu de colonne avec verrouillage, repli et « tout mettre en file ») apparaissent au survol ou au clavier. Les cartes sont plus étroites (colonne par défaut à 280 px au lieu de 320, les colonnes jamais redimensionnées suivent) sans rien perdre : la progression tient sur deux lignes au lieu de quatre (étapes Plan / Code / QA, points de sous-tâches et pourcentage sur une ligne, barre dessous), le pied de carte passe à la ligne au lieu d'écraser la date, et Archiver, Fichiers de la PR et Estimer deviennent des icônes avec leur libellé en infobulle.
- **Recherche des logs : précédent / suivant et filtres.** La recherche de l'onglet Logs d'une
  tâche saute d'un résultat à l'autre (boutons ↑ ↓, Entrée / Maj+Entrée ou F3) avec un compteur
  « 3/12 » ; le résultat courant est encadré et centré. Options Respecter la casse, Mot entier et
  Expression régulière (Alt+C / Alt+W / Alt+R), et un panneau Filtres par phase (Planification,
  Codage, Validation) et par type d'entrée (messages, outils, erreurs, avertissements, statuts).
  Ctrl+F dans les logs place le curseur dans la recherche.
- **Marketplace MCP : 37 serveurs réels, qui arrivent vraiment aux agents.** Chaque serveur a été vérifié (GitHub, GitLab, Azure DevOps, Linear, Jira, Confluence, Notion, Slack, Sentry, Datadog, Figma, Playwright, Chrome DevTools, Microsoft Learn, PostgreSQL, MongoDB, Supabase, Neon, Azure, Kubernetes, Stripe…) ; les paquets inexistants ou dépréciés et les notes inventées sont partis. « Installer » ajoute le serveur au projet sélectionné et aux agents cochés : il apparaît dans Outils des agents et démarre à la session suivante.
- **Marketplace de plugins : 24 skills prêts à l'emploi.** Installer un plugin écrit son skill dans `.agents/skills/` (et `.claude/skills/`) du projet : il se lance en commande `/` du Kanban sur tous les providers, et Codex, Claude Code et pi le lisent. Au menu : audit OWASP, accessibilité, performance, revue de code, tests, et pour .NET Clean Architecture, revue EF Core, revue d'API ASP.NET Core, tests xUnit.
- Les deux marketplaces ne sont plus marquées expérimentales.
- **Administration sur mobile.** Un administrateur gère depuis son téléphone les membres de l'organisation (rôle, retrait), les invitations (envoi par e-mail avec un rôle, lien à partager quand aucun e-mail ne part, révocation), les groupes (membres, projets et rôle donné) et les rôles (création, permissions, suppression ; les rôles intégrés se lisent). Chaque écran n'apparaît qu'avec la permission correspondante, que le serveur revérifie.
- **Un administrateur d'organisation peut inviter.** Les invitations demandaient, en plus de la permission `org.invitation.*`, d'être administrateur de la plateforme : un administrateur d'organisation recevait une erreur, sur le bureau comme sur mobile. Il invite maintenant dans son organisation comme membre ou lecteur ; inviter un administrateur du serveur reste réservé aux administrateurs de la plateforme.
- **WorkPilot sur iPhone et Android.** Une app mobile (`apps/mobile`, Expo et React Native) se connecte au serveur d'équipe : on choisit son organisation, on ouvre un projet et on suit son Kanban en direct. Depuis le téléphone, on crée une carte, on lit sa spec et ce que le build a changé, on approuve, on démarre ou on arrête une phase, on demande des changements, on fusionne ou on ouvre la PR. Le jeton reste dans le Keychain ou le Keystore, et le serveur vérifie chaque droit comme pour l'app de bureau. Le serveur gagne `GET /api/board/cards`, le Kanban sous forme de liste résumée.
- **L'app mobile prévient quand un run se termine.** La personne qui a lancé un run reçoit une notification sur son téléphone quand il réussit ou échoue ; la toucher ouvre la carte. Le serveur n'envoie que le nom du projet, le numéro de la carte, la phase et son résultat, par le service push d'Expo, et seulement si l'opérateur l'active (`WORKPILOT_PUSH_ENABLED`). Sur la fiche d'une carte, l'app permet aussi de modifier son titre et sa description avant que le travail commence, de lire le patch de chaque fichier changé et le rapport QA. Le serveur gagne `PUT` et `DELETE /users/me/devices`, et la fiche d'une carte est lue dans l'espace de build pendant un build.
- **Contexte, jetons personnels et connexion Microsoft sur mobile.** L'app ouvre le contexte d'un projet (son index, avec ses services, son infrastructure et ses conventions, et les mémoires de ses builds, où l'on cherche), gère les jetons personnels que le serveur garde chiffrés (GitHub, GitLab, Azure DevOps, Jira, Linear ; un jeton enregistré n'est jamais réaffiché) et se connecte avec un compte Microsoft quand le serveur propose Entra. Pour cette connexion, l'enregistrement Entra doit déclarer l'URI de redirection `workpilot://auth`.
- **Tableau de bord, sessions et analyses sur mobile.** Depuis le Kanban d'un projet, l'app ouvre le tableau de bord (cartes par colonne, qualité, dépenses), l'historique des sessions (qui a lancé quoi, quand, combien de temps et combien) et les cinq analyses du serveur (accessibilité, i18n, dérive de la documentation, tests instables, dette technique), dont on lit le dernier rapport et qu'on relance. Une connexion refusée dit maintenant « E-mail ou mot de passe incorrect » au lieu de « Votre session a pris fin », et trop de tentatives l'indiquent clairement.
- **GitHub et GitLab sur mobile.** Depuis le Kanban d'un projet hébergé sur GitHub ou GitLab, l'app ouvre ses issues et ses pull ou merge requests : le fil des commentaires, les fichiers changés avec leur patch, les vérifications de la PR (GitHub). On commente, on fusionne après confirmation et on lance la revue IA, qui tourne sur le serveur et dont on lit le verdict et les points relevés. Chaque appel passe par le serveur avec le jeton de la personne, que le téléphone ne voit jamais.
- **Insights, roadmap et idées sur mobile.** Depuis le Kanban d'un projet, l'app ouvre les conversations Insights de l'équipe (on en crée une, on pose ses questions, l'agent répond sur le serveur), la roadmap (vision, phases et fonctionnalités) et les idées classées par type. On peut lancer leur génération, suivre l'agent pendant qu'il travaille et transformer une fonctionnalité ou une idée en carte du Kanban.
- **L'app mobile prend les thèmes de l'app de bureau, et le thème suit la personne d'un appareil à l'autre.** Les sept thèmes de couleur (Default, Dusk, Lime, Ocean, Retro, Neo, Forest), chacun en clair et en sombre, avec les couleurs du bureau ; là où un accent ou une couleur d'état serait illisible sur fond clair ou sombre, il est foncé ou éclairci juste assez pour un contraste de 3:1. Dans Réglages → Apparence, la personne choisit le mode (celui de l'appareil, clair, sombre) et le thème ; le choix s'applique à tout l'écran, en-têtes compris, reste sur le téléphone hors ligne et part sur le serveur. Le serveur gagne `GET` et `PUT /users/me/preferences` (révision Alembic `0009`), qui n'acceptent que les valeurs connues. Connectée à un serveur, l'app de bureau lit ce choix à la connexion et envoie le sien quand la personne change de thème.
- **Mode serveur : un tableau partagé qu'on peut modifier.** Les membres d'un projet créent,
  modifient, suppriment une carte et approuvent sa spec (`/api/board/cards`), chacun selon son
  rôle ; les autres le voient en direct. Un run sur le serveur peut maintenant écrire la spec
  d'une carte (`spec`) et ouvrir sa pull request (`pr`, qui demande `vcs.pr.create` ; `merge`
  demande `task.merge`).
- **Mode serveur : un run ne reste plus bloqué.** Il tourne sans entrée standard et répond seul
  aux questions du build ; l'approbation d'une spec reste celle d'une personne, jamais forcée.
- **Mode serveur : les projets du serveur dans l'app.** Connectée à un serveur, l'app montre ses
  projets à côté de ceux de l'ordinateur, avec votre rôle sur chacun, et « Ajouter un projet »
  demande l'URL d'un dépôt que le serveur clone pour l'équipe. Le tableau d'un projet du serveur
  est celui que voient tous ses membres ; la barre latérale n'y offre que les vues qui passent
  par le serveur.
- **Mode serveur : groupes d'utilisateurs.** Un administrateur réunit des membres de son
  organisation en groupes (« Équipe front », « QA ») depuis l'onglet « Groupes » de
  l'administration, et leur donne d'un coup un rôle d'organisation et un rôle sur des projets. Un
  groupe ajoute des droits, n'en retire jamais, et ne vaut que dans son organisation.
- **Mode serveur : on travaille sur les cartes du serveur depuis l'app.** Dans un projet du
  serveur, créer, modifier, supprimer, démarrer et arrêter une carte passe par le serveur, avec
  les droits de chacun ; le build tourne sur le serveur. Démarrer une carte qui demande une revue
  approuve sa spec au nom de la personne qui démarre, comme dans l'app. Le tableau se met à jour
  toutes les cinq secondes, pour voir ce que font les collègues.
- **Mode serveur : une carte sans revue va jusqu'au build.** La phase `spec` d'une carte qui ne
  demande pas de revue enchaîne le build, comme dans l'app.
- **Mode serveur : on relit, fusionne et propose en PR le travail d'une carte du serveur depuis
  l'app.** Le panneau de revue montre les fichiers et les lignes changés par le build du serveur ;
  « Demander des changements » renvoie la carte au build avec le texte de la personne ;
  « Fusionner » et « Créer la PR » lancent la fusion ou la pull request sur le serveur, avec les
  droits de chacun (`task.merge`, `vcs.pr.create`, `review.approve`).
- **Mode serveur : le tableau d'un projet du serveur se met à jour en direct.** Ce qu'un collègue
  crée, modifie, approuve, lance ou supprime apparaît aussitôt, sans attendre la relecture. Le
  serveur peut indiquer l'adresse publique de son flux (`WORKPILOT_PUBLIC_STREAM_URL`) quand un
  proxy le sert ailleurs que sur le port 8765.
- **Mode serveur : la Roadmap est partagée.** Sur un projet du serveur, la vue Roadmap lit la
  roadmap de l'équipe, la génère et l'arrête sur le serveur (la progression s'affiche comme en
  local, aussi pour une génération lancée par un collègue), enregistre les modifications et les
  glisser-déposer, et fait d'une feature une carte du tableau partagé. Si un collègue a enregistré
  entre-temps, l'enregistrement est refusé et la vue montre sa version au lieu de l'écraser.
- **Mode serveur : l'Idéation est partagée.** Sur un projet du serveur, la vue Idéation lit les
  idées de l'équipe, les génère et les arrête sur le serveur (chaque type d'idée s'affiche dès
  qu'il est prêt, aussi pour une génération lancée par un collègue), écarte, archive et supprime
  des idées, et fait d'une idée une carte du tableau partagé. Si un collègue a changé les idées
  entre-temps, la modification est refusée et la vue se recharge avec sa version.
- **Mode serveur : Insights est partagé.** Sur un projet du serveur, chacun a ses conversations
  Insights, et toute l'équipe peut les lire : celle d'un collègue s'affiche avec son nom, en
  lecture seule. Les réponses sont calculées sur le serveur, à partir du code du projet, et
  s'affichent au fil de l'eau comme en local. Une tâche suggérée devient une carte du tableau
  partagé.
- **Mode serveur : le contexte du projet est partagé.** Sur un projet du serveur, la vue Contexte
  montre l'index du projet tel que le serveur le connaît, et le bouton de rafraîchissement le
  reconstruit sur le serveur. L'onglet Mémoires montre ce que les builds de ce projet ont appris
  sur le serveur, les mêmes pour toute l'équipe, et rien de ce que les builds des autres projets
  ou des autres organisations ont appris.
- **Mode serveur : chacun pose ses propres jetons.** Dans Réglages → Intégrations, « Mes jetons sur
  le serveur » enregistre votre jeton GitHub ou GitLab, votre clé Jira ou Linear et votre jeton
  Azure DevOps sur le serveur, chiffrés. Les builds que vous lancez sur le serveur s'en servent :
  ce qu'ils font sur ces services est fait en votre nom. Un jeton enregistré n'est plus jamais
  affiché, seulement le fait qu'il est là.
- **Mode serveur : les issues et les pull requests GitHub d'un projet du serveur.** Un projet du
  serveur cloné depuis GitHub montre ses vues Issues et Pull requests. Chacun les lit, commente,
  assigne, met à jour une branche et fusionne avec son propre jeton GitHub enregistré sur le
  serveur, depuis n'importe quel ordinateur, sans `gh` ni clone local. « Créer une tâche » sur une
  issue en fait une carte du tableau partagé. La revue IA et l'investigation restent pour plus
  tard sur ces projets.
- **Mode serveur : les issues et les merge requests GitLab d'un projet du serveur.** Un projet du
  serveur cloné depuis gitlab.com, ou depuis une instance GitLab que l'opérateur a nommée
  (`WORKPILOT_GITLAB_HOSTS`), montre ses vues Issues et Merge requests. Chacun les lit, les note,
  les approuve, en ouvre et les fusionne avec son propre jeton GitLab enregistré sur le serveur.
  « Créer une tâche » sur une issue en fait une carte du tableau partagé. La revue IA reste pour
  plus tard sur ces projets.
- **Mode serveur : la revue IA des pull requests GitHub d'un projet du serveur.** Le bouton de
  revue (et la revue de suivi) lance l'agent sur le serveur, sur le clone du projet, avec le jeton
  GitHub de qui le lance. La revue enregistrée est la même pour tous les membres, et publier ses
  findings les poste sur GitHub avec son propre jeton. L'image du serveur embarque désormais le
  CLI GitHub (`gh`), épinglé par version et empreinte.
- **Mode serveur : la revue IA des merge requests GitLab d'un projet du serveur.** Comme pour les
  PR GitHub, le bouton de revue (et la revue de suivi) lance l'agent sur le serveur, sur le clone
  du projet, avec le jeton GitLab de qui le lance. La revue enregistrée est la même pour tous les
  membres, et publier ses findings les poste en note sur la MR avec son propre jeton.
- **Mode serveur : les analyses d'un projet du serveur.** Accessibilité, i18n, dérive de la
  documentation, tests instables et dette technique tournent sur le serveur, sur le clone du
  projet. Leur dernier rapport y est enregistré : chaque membre le voit en ouvrant la vue, avec la
  date du lancement, et un élément de dette devient une carte du tableau partagé.
- **Mode serveur : tableau de bord, analytics, coûts et historique des sessions d'un projet du
  serveur.** Ces quatre vues s'ouvrent maintenant pour un projet du serveur et lisent ce que le
  serveur sait de lui : ses cartes par statut, les runs et les jobs lancés par chaque membre (qui,
  quand, comment ils ont fini), et ce qu'ont dépensé ses agents, lu dans les relevés qu'ils tiennent
  dans le clone du projet. Rien n'est lu sur l'ordinateur pour un projet du serveur ; les routes du
  tableau de bord écrites pour l'app de bureau ne répondent plus qu'en mode local.
- **Tâches multi-dépôts.** Le bouton « Multi-dépôts » de la barre du Kanban lance un changement sur plusieurs dépôts : WorkPilot les ordonne (bibliothèques et API d'abord), ouvre une carte par dépôt dans son propre projet et la lance quand la précédente a passé la QA, en lui décrivant ce que les dépôts précédents ont changé et les ruptures détectées. Une carte qui a besoin de vous met la suite en attente ; l'orchestration s'arrête et reprend où elle en était (F142).
- **Les tests attrapent-ils un bug ? La porte `tests-bite`.** Une fois la QA approuvée, WorkPilot
  plante quelques fautes simples (`>=` devient `>`, `&&` devient `||`, `true` devient `false`…)
  dans les seules lignes que la tâche a écrites, une à une, dans une copie jetable du worktree, et
  lance les tests du fichier muté. Toutes les stacks : un mutateur générique qui ignore
  commentaires et chaînes (C#, TypeScript, Python, Go, Rust, Java, Kotlin, Dart, Swift, PHP…), ou
  StrykerJS et cargo-mutants quand le projet les a. Une faute que les tests ne voient pas renvoie
  au QA fixer comme un test manquant, et il ne peut alors modifier que des tests. Activée pour le
  workflow `test`, et pour toutes les tâches avec `WORKPILOT_QA_MIN_MUTATION` (seuil en %).
- **L'usage des pages s'exporte** (Réglages → Debug & Logs). Le panneau donne la date depuis
  laquelle il compte, la liste des pages expérimentales jamais ouvertes, et un bouton « Exporter
  en JSON » qui enregistre visites et temps passé par page. Rien ne quitte la machine ; c'est la
  donnée sur laquelle se décide le retrait des pages expérimentales.
- **Pointer un élément de l'aperçu et dire quoi changer.** Dans l'onglet Émulateur d'une tâche,
  le bouton « Pointer » active le sélecteur d'éléments des DevTools : cliquez sur un bouton, un
  titre ou une carte de la page, puis écrivez ce qu'il faut y changer. Vous pouvez en pointer
  plusieurs avant d'envoyer. Chacun part à la tâche comme un message de guidage : la prochaine
  session reçoit l'élément, son image, son chemin dans la page, son style et les fichiers qui le
  rendent probablement (React, Angular, Vue, Svelte, Blazor, Razor Pages, Twig, Blade, ERB…).
  Aucun script n'est ajouté à la page, et ce qu'elle contient est transmis comme une donnée,
  jamais comme une consigne.
- **Vérification des preuves formelles.** Un projet qui garde des preuves (Dafny, Lean, Verus,
  F*…) déclare ses vérificateurs dans `[proofs]` de `.workpilot/worktree.toml`. Après
  l'approbation de la QA, ils tournent dans le worktree de la tâche : une preuve refusée renvoie
  le fixer avec la sortie du vérificateur. Nouvelle porte dure `proof-checks` sur les workflows
  qui écrivent du code ; un vérificateur absent ou hors délai donne « inconnu », jamais vert, et
  un projet sans preuve n'est pas concerné. La recette ne tourne qu'approuvée, depuis le projet,
  jamais depuis la branche de la tâche.
- **Un dossier de provenance par PR** (prospective P5). À la création de la PR, WorkPilot rassemble qui a écrit le code et avec quel modèle, les dépendances ajoutées et leur vérification, un SBOM CycloneDX des paquets ajoutés par le diff (toutes les stacks), les portes passées et le verdict de vérification, dans le dossier de la tâche. Le corps de la PR en donne le résumé et le scan de conformité s'en sert comme preuve.
- **Re-revue QA par delta**. Après un rejet, la passe QA suivante vérifie d'abord ce que le fixer
  a changé (lu dans git), les issues encore ouvertes et les tests des fichiers touchés : si une
  issue reste ouverte, elle rejette tout de suite au lieu de relancer l'environnement et toutes
  les suites. La passe qui approuve reste une revue complète. Pour tous les providers ;
  `WORKPILOT_QA_RECHECK=0` la désactive.
- **QA ciblée pour tous les langages**. Une petite modification avec ses tests passe en QA
  ciblée (seuls les tests des fichiers touchés, avec leur couverture) aussi en .NET et Blazor,
  Java, Kotlin, Scala, Go, Rust, PHP, Swift, Dart/Flutter, Ruby, Elixir et C/C++, et pour les
  composants Vue, Nuxt, Svelte, Astro et Angular, plus seulement en Python et TypeScript. Le
  relecteur reçoit les commandes de test et de couverture de son écosystème (`dotnet test`,
  `mvn`/`gradle`, `go test`, `cargo`, `phpunit`, `swift test`, `flutter test`…).
- **Une petite modification de code ne paie plus la QA complète** (K2). Quand une tâche change
  au plus 3 fichiers de code Python ou TypeScript et 150 lignes, et que chacun a un test par
  convention (`test_x.py`, `x.test.ts`…), la QA passe en « QA ciblée » : seuls ces tests sont
  lancés, avec la couverture des fichiers touchés, sans sous-agent, pour tous les providers.
  L'approbation n'est retenue que si chaque test a bien été lancé et est passé. Un fichier sans
  test, un fichier généré ou supprimé, un chemin de sécurité, la CI ou un manifeste de
  dépendances renvoient à la QA complète. Le journal et `qa_report.md` disent quel palier a
  tourné ; `WORKPILOT_QA_TARGETED=0` le désactive.
- **Le journal du build d'une carte du serveur se lit enfin, sur le bureau et sur le téléphone.** En mode serveur, l'onglet Logs d'une tâche restait vide : le journal était écrit dans le clone du serveur et rien ne le servait. Le serveur le sert désormais (`GET /api/board/cards/{id}/logs`, permission de lecture des tâches), en fusionnant la copie du dossier de spec et celle de l'espace de build comme l'app le fait en local, borné et avec les secrets masqués. L'onglet Logs de l'app le relit toutes les 3 secondes tant qu'il est ouvert ; l'écran d'une carte sur le téléphone gagne une section « Journal du build » qui ouvre la phase en cours.
- **Valider un plan depuis la notification, et verrouiller l'app du téléphone.** Quand la spec d'une carte qui demande une revue est prête, la notification dit « Plan prêt à valider » et propose « Valider et construire » et « Voir » ; valider demande Face ID, Touch ID ou l'empreinte, puis lance le build. L'app peut aussi se verrouiller à l'ouverture (désactivé par défaut) et demande la biométrie avant de fusionner, de créer une pull request ou de supprimer une carte (activé par défaut), dans Réglages → Verrouillage.
- **L'app mobile crée une carte comme le bureau** (MO5). L'écran Nouvelle carte choisit le moteur (provider, modèle, effort) et la priorité, sinon la carte tourne avec le défaut du déploiement, et joint jusqu'à 10 images de la photothèque ou de l'appareil photo ; une image refusée (format, plus de 5 Mo, plus de 10) est nommée avec sa raison. La description se dicte avec le micro du clavier. Sur Android, un texte ou un lien partagé depuis une autre app ouvre une nouvelle carte préremplie dans le projet choisi, rien n'étant créé avant que la personne le relise. Le serveur gagne `GET /api/board/engines` (`task.read`), la liste des providers et modèles qu'une carte peut demander.
- **Le panneau de tâche dit d'abord ce qui vous attend, puis range ses cartes en trois onglets** (R5, K1). Une bannière en haut du panneau liste ce qui demande votre intervention maintenant (un plan à approuver, une CI rouge sur la branche de la tâche, des checks rouges sur sa PR, la question d'un agent, un objectif non atteint, un build en échec, une revue) ; chaque ligne ouvre la carte qui la traite. Rien à faire, pas de bannière. Les cartes de la vue d'ensemble sont rangées en **Avancement**, **Qualité** et **Coûts et contexte**, au clavier comme à la souris, et l'onglet choisi est gardé pendant la session ; une carte sans rien à montrer n'apparaît pas. Le pipeline CI de la tâche, et son bouton « Réparer le build », sont maintenant visibles dans le panneau, plus seulement sur le Kanban, et la question d'un agent s'y répond aussi.
- **Les automatisations d'un projet du serveur tournent sur le serveur** (R6, S4). Ses règles sont
  enregistrées sur le serveur et partagées par l'équipe ; le serveur les fait tourner toutes les
  5 minutes, même quand personne n'a l'app ouverte, avec les mêmes règles, plafonds et garde-fous
  que l'app. Chaque règle lit la forge avec le jeton de la personne qui l'a enregistrée en dernier,
  et ses cartes sont créées par le compte « Automations », que le tableau affiche. L'app ne fait
  plus tourner sur l'ordinateur les règles d'un projet du serveur.
- **Une issue GitLab étiquetée crée aussi une carte**, sur le serveur comme dans l'app (pour un
  projet local sans GitHub connecté, avec la connexion GitLab du projet).
- **Une carte du serveur qui t'attend te prévient sur ntfy, Telegram ou Teams.** Quand un run que tu as lancé sur le serveur s'arrête sur un plan à approuver, un travail prêt pour ta revue ou une erreur, le serveur te l'annonce sur les canaux que tu configures pour ton compte (Réglages, « Mes notifications du serveur »), même app fermée. Seuls le nom du projet et le numéro de la carte partent. Le topic, les jetons et l'URL du webhook sont chiffrés sur le serveur et jamais réaffichés ; une destination n'est acceptée qu'en https, vers un hôte public, et Teams seulement sur les hôtes de Microsoft. L'opérateur l'active par `WORKPILOT_NEEDS_YOU_ENABLED`. Le serveur gagne `/users/me/needs-you`.
- **La barre latérale regroupe les vues qui se recoupent en hubs à onglets.** Historique des agents (historique des sessions, replay, débogueur), Coûts et estimation, Outils MCP, Contexte du projet, Impact Git, Historique Git, Docs et dérive, Intégration, Dette et refactoring, Arène : une entrée chacun, et les anciennes vues en onglets. Aucune vue n'est retirée : une vue ouverte par la palette de commandes, une notification, un raccourci ou la recherche s'ouvre dans son hub, sur son onglet, et un favori posé sur l'une d'elles devient celui du hub. Un hub rouvre l'onglet laissé pendant la session. Les onglets se parcourent au clavier (flèches, Début, Fin) ; un outil qui s'ouvre en fenêtre (prédicteur de conflits, arène…) a un onglet qui dit ce qu'il fait et l'ouvre.
- **Mode serveur : le changelog d'un projet du serveur.** La vue Changelog s'ouvre enfin sur un projet du serveur. Le changelog y est généré sur le serveur, à partir des cartes terminées du tableau partagé ou de l'historique git du clone (commits récents, depuis une date ou une version, entre deux tags ou deux branches), avec les mêmes formats et le même texte de prompt que sur l'ordinateur, et un appel au modèle par le fournisseur actif. Le dernier changelog est partagé : chaque membre le voit et peut l'ouvrir, un membre peut le corriger et l'enregistrer pour l'équipe. Rien du projet ne part vers un modèle de l'ordinateur : la version proposée d'après les commits vient de leurs types (`feat`, `fix`, `!`).
- **Ce que chaque exigence est devenue** (prospective P3). À la fin d'un build, chaque exigence `FR-###` de la spec est reliée aux fichiers que ses sous-tâches ont écrits et aux tests qui les couvrent, pour toutes les stacks, et ce lien est gardé dans le projet après la fusion. La carte de traçabilité signale les exigences sans test et les exigences d'autres tâches qui ont touché les mêmes fichiers.
- **Commenter une ligne du diff pendant la revue.** Dans la revue guidée, chaque ligne a un bouton
  « Commenter » (utilisable au clavier). Les commentaires ouverts partent avec « Demander des
  corrections » : le fixer reçoit le fichier, la ligne, l'extrait et la demande. Après sa session,
  WorkPilot marque « traité » chaque commentaire dont les lignes ont été modifiées, d'après le diff
  et non d'après la réponse du modèle. Vous seul résolvez un commentaire. Si les lignes commentées
  ont disparu, le commentaire est signalé plutôt que déplacé au hasard.
- **Le parcours du scénario, en vidéo et en GIF.** Quand une carte porte un scénario de
  vérification, la vérification le filme désormais (WebM, lu dans l'onglet *Vérification*) et
  assemble les captures de chaque étape en un GIF court. Dans la boîte de création de PR, une case
  permet de joindre ce GIF à la preuve visuelle de la PR, après avoir lu qu'il sera visible de
  tous les lecteurs du dépôt. Sur une application de bureau pilotée par CDP, il n'y a pas de vidéo
  et l'onglet le dit ; la trace et les captures restent la preuve. Pillow devient une dépendance
  directe du backend.
- **Mode serveur : chaque vue partagée d'un projet du serveur se met à jour en direct.** La
  roadmap, l'idéation, les conversations Insights et le contexte (index et mémoires) se relisent
  dès qu'un collègue les modifie, lance ou termine une génération, sans recharger la vue. L'app
  n'ouvre qu'une connexion en direct par projet, partagée avec le tableau, tenue tant qu'une de ses
  vues est affichée. Une génération lancée par un collègue est annoncée dès sa mise en file.
- **Tâches empilées.** Une tâche qui attend un prérequis peut partir de la branche de ce prérequis
  au lieu du tronc (« Empiler sur … » dans le détail de la tâche) : son code s'appuie sur celui du
  prérequis avant sa fusion, et sa PR ne montre que son propre diff. « Mettre à jour » rebase la
  tâche quand le prérequis change ; une fois le prérequis fusionné, « Passer sur <base> » la remet
  sur la base et recible sa PR. Un conflit est annulé et ses fichiers listés. Avec l'extension
  `gh stack`, les deux PR sont liées en pile sur GitHub.
- **Guider l'agent pendant qu'il travaille.** Sans mettre la tâche en pause, écrivez un message
  depuis l'onglet Sous-tâches de la tâche, l'app mobile (fiche de la carte) ou la CLI
  (`python run.py --spec 001 --steer "…"`, `--steer-subtask` pour viser une sous-tâche). Il entre
  dans le prompt de la prochaine session concernée (coder ou QA fixer), et la tâche affiche quelle
  session l'a reçu. En mode serveur, envoyer demande la permission `agent.execute`. Les agents ne
  peuvent pas écrire dans cette file.
- **Point périodique des tâches longues.** Avec `WORKPILOT_TASK_DIGEST_HOURS`, chaque build en
  cours envoie à intervalle régulier un point sur les canaux de notification déjà configurés
  (Teams, Slack, Discord, Google Chat, webhook) : sous-tâches terminées sur prévues, ce qui
  tourne, ce qui est bloqué et pourquoi, la passe QA, et « rien n'a bougé » quand c'est le cas.
  Le premier point arrive un intervalle après le début du build ; un build repris après un
  redémarrage ne renvoie pas de point à la reprise. Désactivé par défaut.
- **Barre de progression d'une tâche colorée par phase.** Dans le détail d'une tâche, la barre se
  découpe en planification (jaune), codage (bleu) et validation (violet), chaque segment à la part
  du temps passé dans la phase ; une légende donne le pourcentage et la durée de chacune (par
  exemple 30 % · 40 % · 30 %). La phase en cours scintille. Sans horodatage dans les logs, le
  découpage suit les tranches de progression (20 / 60 / 20).
- **Onglets du détail d'une tâche lisibles.** L'onglet sélectionné ressort dans tous les thèmes
  (soulignement épais à la couleur du thème, fond teinté, texte plein) et la ligne grise sous les
  onglets a disparu. La barre défile horizontalement quand la fenêtre est étroite.
- **Les couleurs de bordure s'appliquent enfin.** Une règle CSS globale forçait toutes les
  bordures au gris du thème : `border-primary`, `border-warning/30`, `border-transparent`… étaient
  ignorés dans toute l'application (cases à cocher, barre de phase des logs, onglets).
- **Collaboration d'équipe sur un projet serveur.** La barre du tableau montre qui est sur le projet et ouvre un chat d'équipe enregistré sur le serveur (réponses, recherche, mentions `@nom`). Chaque carte prise par quelqu'un porte son nom ; son détenteur ou un propriétaire du projet peut la libérer. Une modification de carte qui croise celle d'un coéquipier n'écrase plus rien : les deux versions sont proposées, ou le réglage choisi s'applique. Des notifications signalent les arrivées, les cartes prises ou libérées et la fin des runs de l'équipe ; tout se règle dans Réglages → Collaboration d'équipe (F144).
- **Les profils par défaut passent à Claude 5.5** (F156). Les profils Balanced, Quick Edits, Auto
  et Complex, et les modèles par défaut des fonctions, utilisent désormais Sonnet, Haiku et Opus
  5.5 : moins chers par token que les 4.x qu'ils désignaient (−33 % pour Sonnet, −90 % pour Haiku,
  −20 % pour Opus). Les versions précédentes restent choisissables sous leur nom numéroté. Un
  sous-agent ne tourne plus jamais sur un modèle plus cher que celui de sa carte, et les
  sous-agents qui ne font que lire le code tournent sur Haiku.
- **Comparer avec la branche de base** (prospective P8). L'onglet *Vérification* rejoue, sans modèle, le scénario et les appels vérifiés sur le code dont la tâche est partie puis sur la tâche, et liste ce qui se comporte autrement : étapes cassées ou réparées, erreurs de console, requêtes réseau et statuts d'endpoints, avec la page de fin de chaque côté. C'est une preuve pour la relecture, jamais une porte.
- **Visuel vers Code en graphe de nœuds moderne.** Le canvas devient un graphe sombre : chaque bloc est une carte avec son rôle en petites capitales colorées au-dessus de son nom, et les blocs sont reliés par des connecteurs courbes lumineux où la lumière court dans le sens de l'interaction.
- **Des briques à soi.** « Mes briques » dans la palette : un nom, un rôle (« Agent principal »), une couleur, une icône, une technologie et ce qu'elle fait, réutilisables dans toutes les architectures ; modifier une brique restyle tous les blocs faits avec elle, et sa description part dans la spécification envoyée aux agents.
- **Un texte qui explique chaque interaction.** Chaque connexion porte sa relation et une phrase écrite d'après les deux blocs (« Orders API lit et écrit ses données dans Orders DB ») ; double-clic ou inspecteur pour écrire la sienne, retour au texte automatique en un clic. Les deux arrivent dans la spécification de build.
- **Les couleurs du canvas au choix.** Huit thèmes par architecture (dont celui de l'app), et chaque élément réglable à la main : fond, grille, blocs, bordures, textes, connecteurs ; un bloc ou un connecteur peut aussi avoir sa propre couleur.
- **Toutes les stacks.** Nouveau bloc « Application mobile » (Flutter, React Native, Swift, Kotlin, .NET MAUI, Ionic) et stacks ajoutées : Nuxt, TypeScript, JavaScript, Tauri, FastAPI, Quarkus, Ktor, Laravel, Symfony, Ruby on Rails.
- **Assistant vocal, de partout dans l'app.** Ctrl+Shift+Espace (⇧⌘Espace sur macOS) ouvre
  un panneau qui écoute : « crée-moi une tâche pour ajouter un export CSV », « ouvre la
  fonctionnalité qui me permet de dessiner une architecture », « ouvre les paramètres ». La voix
  est transcrite sur l'ordinateur (Whisper, la dictée du Kanban) ; les commandes simples sont
  comprises sans modèle, les autres par le modèle « Assistant vocal » de Paramètres → Agent,
  quel que soit le fournisseur. Une tâche n'est créée qu'après confirmation, en local comme sur
  le tableau d'un projet du serveur. Le raccourci se change dans Paramètres → Assistant vocal
  (les raccourcis existants et Ctrl+Alt, qui est AltGr, sont refusés), avec une option pour
  qu'il marche même quand WorkPilot est en arrière-plan.
- L'ancienne entrée « Contrôle vocal », qui simulait l'écoute et renvoyait une commande tirée au
  hasard, est remplacée par cet assistant.
- **Préparation des worktrees, pour toutes les stacks.** Chaque nouveau worktree de tâche est
  préparé avant la première session : `npm ci` ou pnpm/yarn/bun, `dotnet restore`, `uv sync`,
  poetry ou pip, `go mod download`, `cargo fetch`, composer, bundler, `flutter pub get`, Gradle ou
  Maven, d'après les fichiers du projet. `.workpilot/worktree.toml` permet d'écrire sa propre
  recette (commandes en liste d'arguments, sans shell ; fichiers ignorés à copier comme
  `.env.local` ; un bloc de ports propre à chaque tâche ; un nettoyage à la suppression). Une
  recette écrite ne tourne qu'une fois approuvée telle quelle, dans Réglages du projet → Général.
  Une étape en échec n'arrête pas la tâche : l'agent la lit dans son prompt. Les agents ne peuvent
  pas modifier la recette.

### 🐛 Corrections

- **OpenCode, pi, Gemini CLI et Google Antigravity se configurent depuis Comptes.** Le bouton
  « Configurer » ouvrait une fenêtre vide et les cartes restaient « Non configuré » même avec le
  CLI installé. La carte suit maintenant l'installation du CLI, et la fenêtre montre son état
  (avec installation en un clic), ouvre un terminal sur la commande de connexion du CLI
  (`opencode auth login`, `pi` puis `/login`, `agy`, `gemini`) et le définit comme fournisseur
  par défaut.
- **Traductions manquantes.** Les descriptions des cartes de ces quatre CLI s'affichaient en clé
  brute (`sections.accounts.providers.opencode`…). Une centaine d'autres clés absentes ou mal
  nommées sont corrigées en français et en anglais : fournisseur personnalisé, terminal de
  connexion GitHub Copilot, configuration Azure DevOps, initialisation Git, estimation
  intelligente (espace de noms jamais chargé), étape CLI de l'onboarding, etc.
- **Une carte créée sans titre sur un projet du serveur est acceptée.** Le titre est facultatif
  dans le dialogue « New Task » ; pour un projet du serveur, la carte prend désormais la première
  ligne de sa description au lieu d'être refusée.
- **L'écran de connexion à un serveur et celui d'une invitation sont traduits** en anglais et en
  français (ils n'existaient qu'en français).
- **Mode Arena : chaque réponse porte le nom du modèle qui l'a écrite.** Les cartes et l'historique affichent le modèle et son fournisseur au lieu de « Modèle A » / « Modèle B ». Un modèle en échec s'affiche comme une erreur et ne peut plus être choisi au vote.
- **Copilot : fin de l'erreur « Copilot token exchange failed (403) ».** Quand GitHub refuse l'échange de jeton interne (cas du jeton de GitHub CLI), WorkPilot utilise directement le jeton GitHub auprès de l'API Copilot, comme pour les comptes d'organisation. Une erreur d'un fournisseur n'est plus jamais rendue comme la réponse du modèle.
- **Le contenu des dossiers `bin/` et `obj/` n'apparaît plus jamais dans les fichiers modifiés d'une tâche, quel que soit le projet.** Le premier correctif ne les excluait que si un projet .NET était détecté, et jamais quand la branche de base versionnait déjà des fichiers `obj/` (fusionnés par une tâche précédente) : un `dotnet restore` réécrivait alors `obj/project.nuget.cache` et les `*.nuget.g.props/targets`, que l'agent commitait. `bin/` et `obj/` sont maintenant exclus partout ; les fichiers que la base versionne déjà sous ces dossiers sont gelés dans le worktree (`skip-worktree`) et ramenés à leur version de base s'ils ont été commités ; la vue des fichiers modifiés les masque aussi.
- **Bounty Board : la spec se choisit dans la liste des specs du projet**. Le champ « Identifiant de spec » acceptait n'importe quel texte quand la liste était vide, et un round pouvait partir sur une spec qui n'existe pas. Il n'y a plus de saisie libre : la liste ne montre que les specs du projet courant (désactivée avec un message s'il n'en a aucune), et le processus principal refuse un identifiant qui ne désigne aucun dossier de spec.
- **Les sorties de build et de test n'apparaissent plus dans les fichiers modifiés d'une tâche.** Pour un projet .NET sans `.gitignore`, une tâche « créer toto.txt » listait 268 fichiers (`bin/`, `obj/`, `TestResults/`). WorkPilot exclut désormais ces dossiers (et `node_modules/`, `__pycache__/`, `target/`, `dist/`… selon la pile détectée) de chaque commit du worktree, quel que soit le fournisseur de l'agent, via un bloc géré dans `.git/info/exclude` (local, jamais commité). Les sorties déjà commitées sont retirées de la branche avant la QA, la revue, la PR et la fusion. Un dossier que le projet versionne déjà (un `dist/` commité) n'est jamais exclu.
- **La colonne « Build rouge » du kanban se comporte enfin comme prévu.** Une tâche dont tout le code est fini n'en ressort plus toute seule vers la revue au rechargement suivant ; elle en sort quand la CI repasse au vert, vers son statut d'avant (revue, PR créée…). Un redémarrage de l'application ne retraite plus un build rouge déjà traité (ni nouveau déplacement, ni nouvelle réparation lancée). Une tâche terminée n'y est plus renvoyée, seul le badge du pipeline montre le rouge. La réparation automatique passe par la machine d'états comme un démarrage depuis le tableau (avant, le run de réparation était ignoré par la carte), ne se lance plus sur une tâche que l'agent exécute déjà, et s'arrête après 3 tentatives sur la même tâche. La colonne n'apparaît plus sur un projet sans pipeline CI.
- **Plus de pile d'erreurs dans les logs quand le registre npm ne répond pas.** La vérification
  de la dernière version de Claude Code, Codex CLI et Copilot CLI écrivait une trace complète
  (`DOMException [TimeoutError]…`) à chaque fois qu'une carte demandait l'état du CLI. Un échec
  réseau donne maintenant une seule ligne courte (`[Codex CLI] Could not check the latest version
  on npm (timed out); next try in 5 min.`), l'app garde la dernière version connue et ne
  réinterroge le registre qu'au bout de 5 minutes. Délai d'attente ramené à 10 s, avec un nouvel
  essai si la connexion est coupée ou si le serveur répond 5xx.
- **Copilot : seuls les modèles de ton compte sont proposés.** La liste des modèles Copilot (Arena, sélecteurs) vient maintenant de l'API Copilot avec ton propre jeton : un modèle absent de ton abonnement ou désactivé par ton organisation n'apparaît plus, au lieu d'échouer en `model_not_supported`. Dans l'Arena, un modèle refusé échoue avec un message clair au lieu d'être remplacé en silence par un autre ; ailleurs, le modèle de repli est choisi parmi ceux que ton compte sert.
- **La traduction inter-langages fonctionne.** La page cherchait son runner hors du dépôt
  (« can't open file … cross_language_translation_runner.py »), le code collé écrasait le premier
  argument, l'appel au modèle n'existait pas et le « repli » rendait le code source en
  commentaires comme s'il était traduit. Elle passe maintenant par le fournisseur IA choisi,
  affiche la traduction en direct, sépare les tests générés dans leur onglet et signale une
  vraie erreur au lieu d'un faux résultat. Les déclencheurs CI/CD avaient le même chemin faux.
- **Page Traduction inter-langages lisible en thème sombre.** Les listes de langages étaient des
  listes natives blanches aux options grises illisibles ; elles utilisent les composants de
  l'application, avec un bouton pour inverser les langages, la copie du résultat et un historique
  daté.
- **Les dates suivent la langue de l'application.** En français, elles s'écrivent à la française
  (`02/11/2026 16:30`, `2 nov. 2026`) ; en anglais, au format américain (`11/2/2026, 4:30 PM`,
  `Nov 2, 2026`), quelle que soit la région de Windows, macOS ou du téléphone. Avant, la plupart
  des écrans suivaient la région du système et certains (issues et merge requests GitHub/GitLab,
  journaux de PR, analyse concurrentielle) étaient figés en anglais. Le menu de restauration des
  terminaux affiche aussi « Aujourd'hui » / « Hier » en français.
- **Plusieurs features du desktop remarchent comme prévu.** Ouvrir une PR revue ne lance plus de processus Python en boucle pour le score qualité. Code Playground, Context Mesh, Learning Loop, Git en langage naturel, Live Companion, le module mobile et l'entretien de spec utilisent le Python de l'app au lieu de celui du système (absent sur un macOS ou un Windows neufs). Les réponses d'Insights gardent leurs lignes vides : paragraphes et blocs de code ne sont plus collés. Après une erreur, la création d'une tâche depuis une issue GitHub montre l'erreur et un bouton Fermer, et la suivante ne s'ouvre plus figée.
- **Douze vues lancent leur agent avec le fournisseur choisi.** Migration de code, Context Mesh, Code Playground, générateur de pipeline, Learning Loop, Live Companion, Auto-Refactor, Git en langage naturel, Design to Code, commande vocale, profileur de performances et visualiseur d'architecture préparent leur runner comme les autres vues : le fournisseur des réglages (ou de la page) et sa clé, la connexion Claude seulement quand elle sert, la sortie non tamponnée en UTF-8. Elles partaient jusqu'ici sur Claude sous un nom de jeton que le backend ne lit pas. La détection de projet de l'émulateur et des appareils mobiles ne reçoit plus d'identifiants.
- **Au premier démarrage, l'assistant de configuration ne cache plus le choix entre mode local et serveur.** Il s'ouvre une fois ce choix fait ; avant, selon l'ordre de chargement, il recouvrait l'écran de connexion et le bouton « Mode local » ne répondait plus (test E2E first-run instable en CI).
- **Le détective de tests instables exécute maintenant les tests lui-même.** La page ne lisait que des rapports déjà présents sur le disque : la plupart des projets n'en gardent pas (`dotnet test` n'en écrit aucun sans `--logger trx`), d'où « 0 instables sur 0 tests » et un message en anglais. Elle détecte la commande de test du projet (.NET, pytest, Vitest, Jest avec jest-junit, Maven, Gradle, Go), l'exécute le nombre de fois choisi avec la sortie TRX ou JUnit, montre chaque exécution pendant qu'elle tourne, et garde les rapports dans `.workpilot/flaky-tests/` pour les analyses suivantes. Un projet serveur exécute ses tests sur le serveur. Une annulation arrête tout l'arbre de processus (hôte de tests `dotnet` compris), une erreur de compilation s'affiche avec la sortie de l'outil, les tests qui échouent à chaque exécution sont listés à part, et tous les textes (causes, corrections suggérées, état vide) sont traduits en français et en anglais.
- **Les petits textes suivent enfin l'échelle de l'interface.** Badges, compteurs, horodatages et onglets de projet étaient écrits en pixels et restaient de la même taille quand on agrandissait l'interface dans les paramètres d'affichage. Ils grandissent maintenant avec le reste.
- **Les skills Hermes `python-debugpy`, `node-inspect-debugger` et `opencode` restent disponibles** : Nous Research les a déplacées dans `optional-skills/`, et la synchro hebdomadaire des skills les aurait supprimées. Le pack Hermes les récupère désormais à leur nouvel emplacement.
- **Les instructions tapées après Ctrl+C sont de nouveau lues par l'agent** (F157). Le CLI
  annonçait que l'agent suivrait les consignes enregistrées dans `HUMAN_INPUT.md` à la reprise,
  mais plus rien ne lisait ce fichier depuis le passage à une session par sous-tâche. La session
  suivante les reçoit maintenant en tête de son prompt, puis WorkPilot archive le fichier
  (`HUMAN_INPUT.<horodatage>.md`) : une consigne s'applique une fois et sa trace reste. Le fichier
  est écrit dans les deux copies de la spec, celle du projet et celle du worktree, et les agents
  ne peuvent pas l'écrire.
- **Jira, Azure DevOps et les réglages de fournisseurs fonctionnent dans l'app installée.** Les connecteurs Python partagés (`src/connectors`) n'étaient pas embarqués : ces vues échouaient à l'import dans les versions installées, alors qu'elles marchaient depuis les sources. Ils sont désormais livrés dans le backend de l'app, et le desktop les y cherche.
- **App mobile : plus de clés brutes à l'écran.** Les statuts du tableau de bord, les phases des sessions et les rôles de projet et d'organisation s'affichent traduits en anglais et en français (« En cours », « Revue IA de PR GitHub », « Mainteneur »…) au lieu de `in_progress`, `github-review` ou `maintainer`. Le message d'autorisation Face ID est traduit en français.
- **Analyses du mode serveur : un écran rouvert retrouve l'analyse en cours.** Le rapport d'une analyse renvoie aussi le run qui tourne ; l'app mobile le suit et propose de nouveau Annuler. Une tâche de projet annulée pendant son démarrage est arrêtée au lieu de tourner jusqu'au bout.
- **CI mobile : fin des tests de connexion qui expiraient au hasard.** Le premier rendu d'un fichier de test transforme tout React Native ; sans cache (CI) il prenait jusqu'à 10 s et dépassait la limite de 5 s par test de Jest. La limite passe à 30 s pour l'app mobile.
- **Le flux en direct d'un serveur marche à nouveau** : avec websockets 17, le serveur de streaming ne lisait plus le canal demandé ni le jeton de l'API et des runs ; connecté à un serveur, on était refusé sur le tableau de son propre projet et aucun événement n'arrivait. Les routes `/projects/{id}/…` répondent aussi 404, et non plus 403, au projet d'une autre organisation.
- **Ajouter un dossier existant mène à son initialisation** (F122). Après « Open existing
  project », rien ne proposait d'initialiser WorkPilot et « New Task » restait grisé. Les
  réglages du projet s'ouvrent maintenant sur le bouton d'initialisation, et le message de
  la barre latérale est un lien vers lui.
- **Plus de « Reconnexion requise » au premier lancement** (F126). Une installation neuve
  annonçait que le compte Claude par défaut avait expiré, alors que personne ne l'avait encore
  connecté. L'alerte ne vise plus qu'un compte déjà connecté qui perd ses identifiants.
- **« Ouvrir dans Obsidian » ouvre de nouveau la note**. Sous WSL, le lien `obsidian://` partait
  vers `xdg-open` côté Linux, qui ne connaît pas Obsidian, avec un chemin `/home/…` ou `/mnt/c/…`
  qu'Obsidian pour Windows n'aurait pas compris : il est maintenant réécrit avec le chemin Windows
  (`C:\…` ou `\\wsl.localhost\<distro>\…`) et confié à Windows. Sur Linux, le lien n'est plus
  passé à un navigateur. Et quand rien ne s'ouvre, une notification le dit au lieu d'un bouton muet.
- **La liste des modèles Ollama ne plante plus quand aucun modèle n'est installé.** Ollama répond alors `"data": null` au lieu d'une liste vide, ce qui faisait échouer le catalogue des modèles (erreur 500) ; le sélecteur affiche désormais une liste vide. Les autres catalogues (Anthropic, OpenAI, Google, Mistral, DeepSeek, Grok, LM Studio) et les écrans de modèles locaux tolèrent la même réponse.
- **Le score de qualité d'une PR GitHub s'affiche enfin.** La vue PR lançait un script introuvable dans l'app installée, avec une commande qui ne produisait rien, dans un dossier qui était en fait l'identifiant du projet : le score n'arrivait jamais. Un runner du backend note désormais les fichiers modifiés de la PR (syntaxe, secrets en dur, appels dangereux, complexité) dans le dossier du projet, sans appel de modèle ni identifiant transmis, et ignore tout fichier hors du projet.
- **Une tâche qui ne crée qu'un fichier texte n'échoue plus en QA, et coûte beaucoup moins de
  jetons** (F133). « Créer toto.txt contenant OK » abandonnait après 3 passes : la barrière de
  couverture à 100 % rejetait chaque approbation, faute de couverture à mesurer sur un `.txt`.
  Quand git montre que seuls des fichiers texte ou de documentation ont changé, la QA fait
  désormais une revue légère (spec et diff dans le prompt, ni suites de tests, ni couverture,
  ni scan du dépôt), pour tous les providers. La QA complète ne cherche plus les failles que
  dans les fichiers modifiés (avant : `grep -r` sur tout le dépôt, `node_modules` compris), et
  le mode TDD ne fait plus écrire de test pour un fichier texte.
- **Une tâche qui ne change aucun code ne se retrouve plus avec de faux projets de tests.** Quand git ne voyait aucun fichier modifié (par exemple `tutu.txt` déjà présent sur la branche de base), la QA passait en revue complète et la barrière de couverture à 100 % faisait inventer au correcteur des projets de tests factices (`DummyTest.cs`, `TESTING.md`). Un changement vide passe maintenant en revue légère, qui vérifie que le dépôt remplit la spec, et la barrière de couverture ne s'applique plus qu'aux changements qui touchent du code.
- **Re-revue QA : un correctif de même taille n'est plus manqué.** L'instantané du worktree
  copiait l'index git sans garder sa date ; sous Windows, une correction de même taille écrite
  dans la même seconde que l'index passait pour « aucun fichier changé », et la passe suivante
  disait au relecteur que le fixer n'avait rien fait.
- **La vue « Spec Approval » approuve vraiment** (F137). Elle liste les tâches dont le plan vous
  attend et décide par le même canal que la carte : approuver lance le build, demander des
  modifications renvoie le plan avec votre retour. Avant, elle écrivait dans des fichiers que
  personne ne lisait et restait vide. La vue « Spec Refinement », qu'aucun code n'alimentait, est
  retirée.
- **Idéation ne boucle plus et accepte tous les fournisseurs.** La page relançait sa vérification
  d'identifiants en continu tant qu'elle était ouverte, et exigeait un compte Claude même quand
  elle tournait sur Codex, Copilot, Gemini ou Ollama.
- **Des noms honnêtes** : les vues qui analysent le code sans appeler de modèle ne s'appellent plus
  « Agent » (Analyse d'accessibilité, Analyse i18n, Kit d'intégration, Contrôles de notebook,
  Aperçu des changements), et l'aperçu des changements n'affiche plus d'étapes ni de coût qu'il
  ne calcule pas.
- **Une carte du serveur tourne enfin avec le moteur, la priorité et l'objectif qu'on lui donne.** En mode serveur, l'app abandonnait le provider, le modèle, l'effort, la priorité et la catégorie choisis à la création d'une carte, et une modification dans le panneau de la tâche (moteur, objectif) s'écrivait dans le miroir local, que le serveur ne lit jamais : la carte tournait sur le moteur par défaut du serveur, sans objectif. Le serveur les accepte désormais (`PATCH /api/board/cards/{id}/settings`), les valide (provider connu, objectif vérifié avec les règles du build) et les écrit là où le build les lit ; ils restent modifiables après le début du travail, sauf pendant un run. Modifier le moteur d'une carte déjà commencée n'échoue plus parce que l'app renvoyait son texte inchangé. Le téléphone affiche avec quoi la carte tourne.
- **La PR d'une carte du serveur reprend ce que tu as retouché dans le dialogue.** En mode serveur, « Créer la PR » ne transmettait que la demande : le titre, le corps, la branche cible et l'option brouillon modifiés dans le dialogue étaient perdus, et le serveur écrivait les siens depuis la spec. Ils partent maintenant avec le run, vérifiés par le serveur (titre d'une ligne, branche au nom sûr, corps borné et passé par un fichier).
- **Les images partent enfin vers une carte du serveur.** En mode serveur, les images jointes à une nouvelle tâche étaient perdues sans un mot, et celles d'une demande de changements refusées (« pas encore »). Elles partent maintenant avec la requête, le serveur vérifie leurs octets (PNG, JPEG, GIF ou WebP, au plus 10 de 5 Mo ; pas de SVG) et les range là où les agents les lisent, comme l'app le fait en local : `attachments/` de la carte, `feedback_images/` de l'espace de build. Une image que le serveur n'accepterait pas est refusée dans l'app, jamais perdue.
- **L'interface parle enfin la langue choisie partout.** Plus d'un millier de textes écrits en dur dans les
  composants (boutons, titres, champs, infobulles, messages d'attente) passent désormais par les
  traductions, en anglais et en français : un utilisateur francophone ne lit plus d'anglais dans les
  réglages, les vues GitHub, GitLab, Jira, Linear, la feuille de route ou la revue des tâches, et
  quelques panneaux restés en français s'affichent maintenant en anglais pour un anglophone. Au
  passage, des caractères mal encodés (`Â·`, `âŒ˜`) sont corrigés, et un bout de code qui
  s'affichait comme du texte dans la vue de refactorisation n'apparaît plus.
- **Un texte en dur ne peut plus revenir.** Un test lit chaque composant du renderer et refuse tout
  texte visible hors de `t()`. Les seules exceptions (noms de marques, commandes, unités) sont
  listées avec leur raison dans `jsx-literal-allowlist.ts`.
- **Couleurs de statut lisibles dans tous les thèmes.** En thème clair, l'avertissement jaune, le succès vert, l'info bleue et l'erreur rouge passaient sous le seuil de lisibilité sur le fond de page et les cartes (l'avertissement du thème par défaut tombait à 1,4:1). Ils sont assombris en gardant leur teinte, avec un texte blanc sur les pastilles d'avertissement ; quelques thèmes sombres aux cartes claires (Forest, Ocean, Retro, Dusk) les éclaircissent. Toutes atteignent désormais 4,5:1, vérifié par un test sur les 14 variantes.
- **L'alerte « commandes non isolées » dit comment y remédier**. Quand `socat` (exigé par le bac
  à sable de Claude Code sous Linux et WSL) ou `bubblewrap` manque, la raison affichée sur la
  carte et dans le fil de la tâche donne la commande d'installation du gestionnaire de paquets
  trouvé (`sudo apt install socat`, dnf, pacman, zypper, apk), à lancer avant de relancer la tâche.
- **Mode serveur : annuaire, membres et rôles suivent l'organisation.** La liste des personnes proposée pour ajouter un membre ne montre que l'organisation active, un projet n'accepte que des membres de son organisation, un compte désactivé est refusé dès la requête suivante, une organisation garde toujours au moins une personne qui peut gérer ses membres, et l'historique d'administration montre aussi les événements des projets (suppression, réclamations, runs). Réclamer, libérer ou annuler le run d'une carte, et enregistrer un nouveau projet, suivent aussi le rôle dans l'organisation : un lecteur ou un relecteur consulte sans modifier.
- **Un serveur ne sert que les features des projets d'une organisation.** En mode serveur, le tableau, les features partagées et l'espace de travail d'un projet restent servis par son `project_id` ; les outils de la machine écrits pour l'app de bureau (hooks, coûts et budgets, santé des agents, replay, réglages des fournisseurs…) ne sont plus montés et répondent 404, et le planificateur des hooks n'y démarre pas. Ils restent entiers dans le backend local de l'app. Une nouvelle feature déclare où elle est servie (`SERVER_FEATURES` ou `LOCAL_ONLY_FEATURES`), et une feature d'aucune liste n'est pas montée sur un serveur.
- **Les projets de l'ordinateur fonctionnent pendant la connexion à un serveur.** L'app lance
  toujours son backend local, et les outils propres à la machine (hooks, mémoire, notifications,
  boucle d'apprentissage) lui parlent au lieu d'appeler le serveur.
- **Mode serveur : le passage des comptes d'un serveur mono-organisation dans l'organisation par
  défaut n'a lieu qu'une fois.** Il est enregistré à la mise à niveau (révision Alembic `0007`)
  et le démarrage du serveur ne le refait plus : une personne membre d'une autre organisation, ou
  d'aucune, reste où un administrateur l'a placée. Une invitation appartient désormais à
  l'organisation où agit l'administrateur qui l'émet, avec le rôle qu'elle enregistre ; l'accepter
  fait entrer la personne dans cette organisation. La liste et la révocation des invitations ne
  voient que celles de l'organisation active, et une invitation antérieure sans organisation est
  refusée : en émettre une nouvelle.
- **Mode serveur : une carte ne reste plus bloquée « en cours » après un redémarrage du serveur.** Les runs qu'un serveur arrêté laissait en file ou en cours sont clos en échec au redémarrage, et ne bloquent plus le quota de l'organisation. Stop arrête aussi un run encore en attente d'une place. Sur le téléphone, une carte dans une colonne active sans run propose « Relancer » au lieu d'un Stop sans effet, et le rafraîchissement automatique de la carte ne fait plus tourner l'indicateur de tirage.
- **Les champs de saisie et les listes déroulantes se ressemblent dans toute l'application.** Une centaine de champs avaient leur propre bordure, leur propre fond et parfois aucun repère de focus au clavier. Ils utilisent maintenant les mêmes composants, avec un anneau de focus visible, sans changer de taille.
- **Toutes les vues ont maintenant le même en-tête et le même état vide.** Une vingtaine de vues (Documentation, Historique des sessions, Administration, Self-Healing, Browser Agent, Marketplace, Revue de code...) avaient chacune leur taille de titre et leur mise en page : elles affichent désormais l'icône de la barre latérale, le titre, la description et leurs actions au même endroit. Les états vides des issues, des PR, de l'API Explorer et de l'aperçu mobile se ressemblent aussi.
- **Le marqueur « Expérimental » ne tronque plus le nom des vues dans la barre latérale.** Le badge texte, qui réduisait par exemple « Garde de régression » à « Gar… », devient une petite fiole ambrée posée sur le coin de l'icône : le libellé garde toute sa largeur, le survol explique ce que signifie la fiole, et la barre repliée affiche la même marque dans la liste de chaque groupe. Un libellé encore trop long pour la largeur choisie affiche son nom complet au survol.
- **Une spec suit toujours la description de sa tâche.** Une spec n'était écrite qu'une fois, et « `spec.md` existe » valait « spec à jour » : une tâche dupliquée puis redécrite pouvait tourner sur la spec de l'originale. La spec enregistre maintenant la description dont elle provient (`spec_source.json`). Chaque lancement d'une tâche pas encore planifiée la régénère si la description a changé, quel que soit le chemin de la modification. Le QA reviewer et le QA fixer lisent aussi la demande de l'utilisateur : quand la spec la contredit, la demande l'emporte, et l'écart est signalé au lieu de supprimer le fichier demandé.
- **Modifier la description d'une tâche pas encore lancée (une tâche dupliquée par exemple) régénère sa spec.** Seule la section « Overview » du `spec.md` était réécrite : une copie de « Créer toto.txt » renommée en « tata.txt » gardait une spec qui demandait `toto.txt`, et le QA supprimait le `tata.txt` créé par l'agent. La spec et ce qui en dérive (`context.json`, indices du Brain, évaluation de complexité) sont maintenant retirés et réécrits au lancement à partir de la nouvelle description. La mémoire du projet injectée aux agents précise aussi qu'elle parle d'autres tâches et ne remplace jamais un nom de fichier de la tâche en cours.
- **Le lancement de l'application ne remplit plus la console de messages inutiles.** Plus d'avertissements de build `INEFFECTIVE_DYNAMIC_IMPORT`, plus d'avertissements Electron sur les appels `safeStorage` synchrones dépréciés (le chiffrement des secrets passe par l'API asynchrone), plus d'avertissement Node `DEP0190` ni de `RuntimeWarning` Python au démarrage du serveur de streaming. Les outils CLI (Claude, Git, gh…) ne sont plus redétectés à chaque lecture des réglages, les vérifications de version Claude Code, Copilot et de mise à jour lancées en même temps n'en font plus qu'une, et la base analytics n'est plus initialisée deux fois. Les messages d'information (handlers enregistrés, environnement Python, détections…) ne s'affichent plus qu'avec `DEBUG=true` (`pnpm dev:debug`).
- **Les couleurs de succès, d'avertissement et d'erreur suivent le thème choisi.** Près de 230 écrans prenaient leur vert, leur jaune et leur rouge directement dans une palette fixe : la même alerte changeait de teinte d'un écran à l'autre et restait parfois peu lisible en thème clair. Elles utilisent maintenant les couleurs d'état du thème actif, réglées pour rester lisibles dans les sept thèmes.
- **L'onglet « Fichiers » d'une tâche montre les fichiers qu'elle a créés ou modifiés.** Il ne listait que le dossier de spécification, et une tâche créée pendant la session n'en avait même pas le chemin : « Aucun fichier de spécification disponible » s'affichait alors que la tâche avait bien créé `test.txt`. Les fichiers de la tâche (créés, modifiés, supprimés, lus dans le worktree, ou dans le projet une fois fusionnés) viennent maintenant en tête, la spécification en dessous.
- **Les réglages de tokens atteignent enfin le modèle** (F153). L'effort choisi sur une carte est
  envoyé à tous les modèles Claude qui l'acceptent (Sonnet 4.6 et 5.x, Haiku 5.5, Fable), plus
  seulement à Opus. Mistral met désormais l'entrée en cache (clé par tâche et phase), Grok reçoit
  son header de routage de cache, et Claude ne paie plus chaque écriture de cache au tarif d'une
  heure hors abonnement.
- **La vérification d'une app Windows ne renonce plus au premier démarrage.** Le module UI
  Automation compilait son code C# à chaque lancement, ce qui prenait 40 à 60 s sur une machine
  froide et dépassait parfois la minute accordée (« the UI Automation helper did not start »). Il
  est maintenant compilé une fois puis réutilisé, et la première compilation dispose de son propre
  délai.
- **Une sous-tâche bloquée dit pourquoi et se débloque depuis son panneau.** Sous chaque sous-tâche bloquée (ou échouée), l'onglet Sous-tâches affiche la raison, ce qu'il faut faire, et quatre réponses : « C'est fait », « Réessayer », « Répondre à l'agent » (la réponse arrive dans le prompt du codeur et la tâche redémarre) et « Pas nécessaire ». Ça marche pour une tâche locale comme pour une carte du serveur, sur tous les providers.
- **Une vérification que l'agent peut faire lui-même n'est plus bloquée.** Le prompt du codeur ordonnait de bloquer toute vérification qui n'était pas une commande, un appel d'API, un contrôle navigateur ou un scénario E2E (y compris `none`), avec une raison écrite dans un champ que l'app ne lisait pas : « Vérifier que test.txt contient 'OK' » finissait « Bloquée — intervention manuelle requise ». L'agent lance maintenant la vérification avec ses outils, quel que soit le langage, et ne bloque que ce qui demande vraiment une personne, avec une raison lisible. La boucle ne transforme plus en blocage une vérification manuelle que l'agent a terminée.
- **Un fichier créé par une tâche mais jamais commité apparaît dans « Fichiers modifiés » et n'est plus perdu à la fusion.** La liste ne lisait que les commits de la branche : un fichier que l'agent avait créé sans le commiter donnait « 0 files changed », et la fusion le laissait dans le worktree. La vue compare maintenant le worktree lui-même avec la base (fichiers commités, modifiés et non suivis), une erreur git s'affiche comme une erreur au lieu d'une liste vide, et la fin du build comme la fusion commitent ce que l'agent a laissé en attente.
- **Les panneaux, cartes et bordures d'une quarantaine de vues réapparaissent et suivent le thème.** API Explorer, Self-Healing, Browser Agent, Context Mesh, Live Companion, Code Migration, CI/CD Triggers, Pipeline Generator, Agent Coach, Compliance et d'autres écrivaient leurs couleurs avec des variables qu'aucun thème ne définit : le fond et les bordures disparaissaient et le texte secondaire n'était pas atténué. Elles utilisent maintenant les couleurs du thème actif.
- **La vérification ouvre dans Chrome toutes les apps web, quelle que soit la stack.** La phase
  *Vérification* d'une tâche pilote Chrome DevTools MCP (Playwright en secours) pour lire la
  console et le réseau, faire les captures desktop et mobile et tracer la performance. Les pages
  rendues par un backend (Blazor Server / Blazor Web App, Razor Pages, MVC, Django, Flask,
  Express avec vues, Thymeleaf, templates Go, Rails, Laravel…) étaient prises pour une simple API
  et jamais ouvertes : elles le sont maintenant, en plus des appels d'endpoints. PHP (Laravel,
  Symfony, PHP simple), Ruby (Rails, Rack), Rust (Leptos, Yew/Trunk, Dioxus, Axum, Actix,
  Rocket…), les sites statiques et React sur webpack, Remix, Gatsby, Solid, Qwik, Lit, Ember,
  Docusaurus ou Eleventy sont détectés et lancés.

### 🔒 Sécurité

- **Garde contre les paquets inventés.** Un agent peut ajouter une dépendance qui n'existe pas, et
  quelqu'un peut la publier ensuite pour faire installer son code (*slopsquatting*). Après
  l'approbation de la QA, les paquets que la tâche a ajoutés à un manifeste (npm, PyPI, NuGet,
  Maven/Gradle, Cargo, Go, Composer, pub, RubyGems) sont cherchés sur leur registre public. Un
  paquet inconnu du registre renvoie le QA fixer le remplacer. Un flux privé déclaré, un paquet
  déjà installé, un registre qui ne répond pas ou le mode hors-ligne strict ne bloquent jamais :
  le verdict est « inconnu ». Un nom à une frappe d'un paquet populaire avertit. Nouvelle porte
  dure `deps-exist` sur les workflows qui écrivent du code ; `WORKPILOT_DEPENDENCY_GUARD=0` coupe
  la garde.
- **Dépendances JavaScript à jour des avis de sécurité publiés** : `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `qs` et `postcss-selector-parser` passent aux versions corrigées.
- **Vos réglages Claude personnels ne guident plus que le coder** (K3). Votre `~/.claude` (votre `CLAUDE.md`, vos skills, vos hooks) et le `.claude/settings.local.json` du projet étaient chargés par toutes les sessions Claude, planner et QA compris. Seul le coder les charge désormais ; les autres agents ne lisent que les réglages du projet, ce qui rend la planification et la revue identiques d'une machine à l'autre. `AUTO_CLAUDE_CODER_USER_SETTINGS=false` les retire aussi au coder, `AUTO_CLAUDE_SETTING_SOURCES` impose une liste à tous les agents.
- **Épinglage des outils MCP.** La description d'un outil MCP est lue par le modèle et jamais
  montrée : un serveur peut y cacher des instructions, ou changer ses outils après coup. Les
  outils de chaque serveur MCP personnalisé sont maintenant épinglés par l'empreinte de ce que lit
  le modèle. Un outil ajouté ou une description modifiée est retenu tant que vous ne l'avez pas
  approuvé, dans Outils des agents → serveurs MCP, avec l'ancienne description à côté de la
  nouvelle. Une description qui ressemble à une instruction cachée demande une confirmation
  explicite. Les serveurs déjà configurés sont épinglés au premier contact. Les agents ne peuvent
  pas écrire `.workpilot/mcp-pins.json`.
- **Serveurs MCP HTTP.** Avec le SDK MCP 2, le pont WorkPilot ne parvenait à joindre aucun serveur
  personnalisé en HTTP (`streamablehttp_client` a été renommé) ; il utilise maintenant le nouveau
  transport.
- **Mode serveur : le flux en direct s'arrête au tenant.** Un canal du serveur de streaming ne
  s'ouvre qu'aux membres de son projet, dans l'organisation où ils agissent ; seuls les jetons
  de service publient, et le jeton d'un run n'ouvre que le canal de ce run. Des réglages serveur
  illisibles laissent le serveur fermé.
- **Mode serveur : un run démarre avec un environnement construit.** Plus aucune variable propre
  au serveur (clé des jetons, clé des secrets, base de données, mail) n'arrive à un agent ; un
  test refuse toute nouvelle variable du serveur qui ne serait pas classée.
- **Mode serveur : chaque run ne voit que son projet sur le disque.** Un build lancé sur le
  serveur est confiné par Landlock à son clone, au dossier de son projet et à son dossier
  temporaire : les projets des autres équipes, le dossier de l'utilisateur du serveur et l'état du
  serveur lui sont fermés. Il faut Linux 5.13 ou plus ; sinon le run échoue avec la raison
  (`WORKPILOT_RUN_ISOLATION=off` pour un déploiement où chacun peut tout lire).
- **Le garde d'injection est mesuré sur 51 charges connues** (F128). Une issue, une PR ou un
  commentaire de revue qui s'adresse à l'agent, lui demande un secret, un push sans revue ou un
  script distant, ou cache sa consigne (lettres espacées, caractères d'aspect latin, octets
  échappés) est désormais signalé dans le journal de la spec ; le jeu de charges tourne en CI.
- **Chaque release publie son SBOM et une attestation de provenance**. `workpilot-sbom.cdx.json`
  liste les paquets npm et Python de la version, et chaque fichier publié se vérifie avec
  `gh attestation verify <fichier> --repo krovomi/WorkPilot-AI`.
- **Réglages > Comptes dit depuis quand chaque clé d'API est enregistrée** et suggère de la
  renouveler après 90 jours. Une clé enregistrée avant cette version reste « date inconnue »
  plutôt que d'être présentée comme neuve.
- **Jetons de tâche en mode serveur.** Un jeton d'accès peut maintenant être limité à une carte :
  il n'atteint que le projet de la carte, ne modifie que cette carte, dure quelques heures et
  est révoqué dès que la carte est terminée. Les écritures faites par `/mcp` sont inscrites dans
  l'audit avec la tâche qui les a faites, pas seulement la personne.

### 🛠️ Qualité

- **Les erreurs avalées et les `biome-ignore` ne peuvent plus que diminuer** (F127). Chaque
  fichier garde un plafond d'`except Exception` et de `biome-ignore` ; une PR qui en ajoute est
  refusée, une PR qui en retire fait baisser le plafond (`python scripts/quality_baselines.py update`).
- **Les types Python sont vérifiés en CI** (F127). pyright `1.1.408` tourne sur sept paquets du
  backend (`bench`, `best_of_n`, `genai_trace`, `goal`, `mcp_tasks`, `os_sandbox`, `security`),
  remis à zéro erreur ; la liste s'élargit paquet par paquet.
- **Moins de re-rendus dans les réglages, les assistants et le terminal**. Seize composants
  s'abonnaient à tout le store des réglages et se redessinaient à chaque changement, même sans
  rapport ; ils ne lisent plus que les champs qu'ils affichent.
- **Le cycle d'imports des agents tombe à 10 unités, l'objectif du plan** (F131). Les parseurs
  de journaux de CI (`foundation/ci_logs.py`), la traçabilité des exigences
  (`foundation/traceability.py`) et la pagination (`foundation/paging.py`) descendent dans
  `foundation` ; la phase `architecture-map` passe dans `workflows/architecture_map_phase.py` et
  ses prompts dans archify. Le cerveau, la mémoire, la boucle d'apprentissage, hermes, docintel,
  self_healing, uiux et archify sortent du cycle.
- **La boucle d'apprentissage dit ce qu'elle fait** : son analyse « avec IA » importait un
  module qui n'a jamais existé et retombait toujours sur l'heuristique. L'appel mort est retiré,
  le statut ne parle plus d'IA ; les motifs extraits sont les mêmes qu'avant.
- **Le cycle d'imports des agents recule à 18 unités** (F131). Le registre des sous-agents
  devient une unité à lui (`apps/backend/subagents/`, ex-`agents/subagents/`) ; le générateur de
  tests passe dans `test_generation/generator.py` et appelle le modèle par le port
  `agent_runtime` ; `error_details` et la prévision du plan descendent dans `foundation`. Les
  chemins changent, pas le comportement.
- **Le cycle d'imports des agents recule à 20 unités** (F131). Le résolveur de conflits de
  merge, le client Linear, l'extracteur d'insights et le relecteur d'architecture lancent leur
  session par un port, `agent_runtime`, que `core` installe, au lieu d'importer `core` ou
  `agents`. Aucun client en plus : chaque appel va aux mêmes fabriques, avec les mêmes hooks et
  les mêmes droits d'outils.
- **Un gros fichier source ne peut plus grossir** (F130). Les 21 fichiers de plus de 2 000 lignes
  gardent un plafond à leur taille du jour, un nouveau fichier au-delà de 2 000 lignes est
  refusé ; une découpe fait baisser le plafond (`python scripts/quality_baselines.py update`).
- **Les handlers de worktree sont répartis par groupe** (F130). `worktree-handlers.ts` passe de
  3 629 à 1 216 lignes : le diff, la fusion, les fichiers, la création de PR et la preuve
  visuelle ont chacun leur module. Aucun changement de comportement.
- **Le cycle d'imports des agents recule à 24 unités** (F131). Les logs, la redaction, la
  branche de base, les signaux de pause et le slug des logs par LLM passent de `core` à
  `foundation`, la couche qui n'importe rien du backend. Les chemins changent
  (`core.debug` devient `foundation.debug`, `core.log_redaction` devient
  `foundation.log_redaction`…), pas le comportement.
- **`agents/session.py` repasse sous son plafond de taille** : l'affichage d'un appel d'outil
  dans le fil d'activité et la vue streaming part dans `agents/tool_display.py` (2 591 → 2 482
  lignes).
- **Les handlers d'exécution des tâches sont répartis par groupe** (F130). `execution-handlers.ts`
  passe de 3 092 à environ 500 lignes : la revue, le changement de statut, la reprise et la
  récupération d'une tâche bloquée ont chacun leur module. Aucun changement de comportement.

### 🧪 Filets de test

- **L'app de bureau est testée contre un vrai serveur.** Deux membres d'une même organisation se
  connectent chacun depuis l'app : la carte que l'un crée apparaît en direct chez l'autre, celle
  qu'il supprime disparaît, et une personne d'une autre organisation ne voit pas le projet (job CI
  `app-server-e2e`).
- **Deux tests qui échouaient au hasard en CI ne le font plus**. Le test du banc de rejeu datait
  ses cartes l'une après l'autre : sur Windows, l'horloge avançait d'une milliseconde entre deux
  cartes et l'ordre attendu s'inversait ; les cartes partagent maintenant le même instant, et un
  nouveau test vérifie que la carte terminée la plus récente vient en tête. Le smoke test
  d'Electron réessaie la suppression de son profil temporaire et n'en fait plus dépendre son
  verdict.
- **Deux organisations sur un vrai serveur, de bout en bout** (lot MT5) : le job `server-e2e` démarre le serveur comme `deploy/` contre PostgreSQL, crée deux organisations par l'API, fait travailler chacune (cartes, flux en direct, un run avec un agent factice confiné, un job) et vérifie que l'autre reçoit 404 partout, que son flux lui est refusé, et qu'un lecteur ne peut rien écrire.
- **Actions GitHub épinglées par SHA** (F121), suivies par Dependabot jusque dans les
  actions composites.
- **Des planchers de couverture qui comptent** (F119) : 58 % pour le backend (60 %
  mesurés, contre 10 % exigés jusque-là), et un seuil Vitest, qui n'existait pas.
- **L'app est démarrée avant d'être publiée** (F120). La CI lance le build sur les trois
  OS et la release chaque app packagée avant l'envoi ; l'app doit monter son interface,
  sinon le job échoue. La 1.3.1, qui ne démarrait pas, n'aurait pas pu sortir.
- **De vrais tests de bout en bout** (F123). Les anciennes specs Playwright n'ouvraient pas
  l'app ; elles sont remplacées par un parcours du premier lancement dans l'app construite,
  lancé en CI sous xvfb.
- **Le contrôle des skills générés peut de nouveau échouer** (F125). La CI reconstruisait les
  skills juste avant de vérifier qu'elles étaient à jour ; les skills lues par les agents avaient
  pris du retard sur leurs sources depuis la dernière synchronisation. Elles sont régénérées, et
  la synchronisation hebdomadaire committe désormais ce qu'elle reconstruit.
- **Le smoke test Electron ne plante plus au hasard en fin de course** (F134). Il quittait l'app
  sans son nettoyage pendant que les DevTools s'ancraient dans la fenêtre fermée (SIGILL) ; il
  quitte maintenant comme un utilisateur, sans DevTools. Quitter l'app pendant l'installation
  des dépendances Python arrête aussi `pip` au lieu de le laisser tourner.

### 📚 Documentation

- **Mode serveur : un guide d'exploitation.** `docs/server-operations.md` dit comment déployer le
  serveur d'une équipe sans lire le code : secrets à générer, accès Git, premier administrateur,
  proxy TLS devant l'API et le flux en direct, chaque variable avec son défaut, sauvegarde et
  restauration (PostgreSQL, clones, clé maître), mise à jour et retour en arrière, quotas, audit,
  changement des clés, run bloqué, et ce qui n'existe pas encore. `deploy/` gagne un exemple de
  proxy Caddy prêt à copier, et les copies locales (`.env.server`, clé SSH) sont ignorées par git.
- **Des PR parallèles qui ne se marchent plus dessus.** Chaque constat d'audit (depuis F113),
  chaque annexe du cahier et chaque entrée du changelog est désormais un fichier à part :
  `docs/audit/findings/`, `docs/audit/annexes/`, `changelog.d/`. L'atlas charge les constats
  depuis leurs fichiers.
- **Le README montre l'application.** Captures du Kanban, du détail d'une tâche, d'Insights, de la roadmap, de l'idéation, du tableau de bord et de l'app mobile, prises dans la vraie application remplie d'un projet de démo inventé. `scripts/readme-screenshots/` les régénère sans backend ni compte.
- **Conformité aux standards ouverts.** Une page dit quelles versions de MCP, ACP, AGENTS.md et
  des conventions OpenTelemetry GenAI WorkPilot parle, et, pour chaque provider, comment les
  outils MCP et les instructions du projet l'atteignent. `capabilities/providers.yaml` gagne un
  champ `standards`, vérifié contre le code par un test : un provider dit « relié à MCP » tourne
  sur un client qui a le pont, un provider dit « reçoit AGENTS.md » est construit avec le prompt
  qui le porte. Ce qui n'est pas vérifié est marqué `unverified`, jamais compté comme un support.

### 🧹 Maintenance

- **Les artefacts de la CI ne remplissent plus le quota de stockage GitHub.** Chaque upload garde
  ses fichiers 3 jours au plus (1 jour pour les builds de release, déjà publiés sur la page de la
  release), et `artifact-cleanup.yml` supprime chaque nuit ce qui est plus ancien ; un lancement
  manuel avec `max-age-hours: 0` vide tout. `tests/test_artifact_retention.py` garde la limite.
- **`pnpm dev` ne montre plus l'avertissement `MODULE_TYPELESS_PACKAGE_JSON` au démarrage du backend.** Le lanceur `apps/backend/dev-server.js`, écrit en modules ES, s'appelle désormais `dev-server.mjs` : Node le charge directement en ESM au lieu de le relire une seconde fois.
- **Environ 9 900 lignes de Python que rien n'appelait retirées du backend** (F140) : anciens modules remplacés (journal d'audit, historique de sessions, critique de spec, orchestrateur de services…), façades de compatibilité sans importeur et les deux skills Python que plus aucun code ne chargeait.
- **Deux fonctions sans écran retirées de bout en bout** (F141) : l'ancien agent de documentation par IPC (la page Documentation reste) et le journal de décisions, qui écrivait un fichier à chaque appel d'outil sans que rien ne le lise.
- **Dépôt nettoyé des scripts ponctuels et des fichiers que rien ne lisait** (F139) : diagnostics Azure d'un seul incident, hooks `.bat` que Git n'exécute pas, `config/` en double, ancienne application `.design-system/`, logos jamais importés, husky et lint-staged du frontend qui ne tournaient pas.
- **L'annonce Discord ne laisse plus de run rouge** (F118). Sans le secret
  `DISCORD_WEBHOOK_URL`, le workflow dit que la release n'est pas annoncée et se
  termine vert.
- **Le marqueur `RESUME_WITH_PROVIDER` n'est plus lu** (F25 de l'audit). Plus rien ne
  l'écrit depuis #290 : reprendre une tâche avec un autre provider verrouille le moteur
  de la tâche dans `task_metadata.json`. La lecture gardée une version pour les tâches
  mises en pause sous 1.2.1 est retirée, et la résolution du provider n'a plus d'effet
  de bord.
- **Un seul mécanisme de variantes : Best-of-N.** `parallel_variations` (copie de spec sans
  agent, éteinte par défaut, et dont la boîte de dialogue n'était montée nulle part) est
  supprimé, avec sa route `/api/parallel-variations/*` et la variable
  `WORKPILOT_PARALLEL_VARIATIONS`. `replay` et `bench` restent séparés : l'un enregistre les
  sessions, l'autre rejoue des cartes pour noter les moteurs
  (`docs/architecture/variants-and-replays.md`).
- **Un fork de Time Travel ne prend plus de clé d'API.** Un fork est enregistré, jamais exécuté ;
  le champ ne servait à rien, et un ancien fichier de fork qui en porte une la perd à sa
  première lecture.
- **La synchro hebdomadaire des skills ouvre des PR que la CI peut valider** : elle régénérait les fichiers des skills avec des packs téléchargés mais non versionnés, ce qui ajoutait une cinquantaine de skills qu'un clone propre ne reproduit pas et faisait échouer la vérification « Skills (generated output) ».

---

## 1.3.3 - La reconnexion Claude tient sous Linux et WSL

Correctif de la 1.3.2 : après un `/login` réussi sous Linux ou WSL, l'application
retombait aussitôt en « reconnexion requise ». Le wiki suit aussi chaque release
sans intervention.

### 🐛 Corrections

- **Boucle de reconnexion Claude sous Linux et WSL** (#543). WorkPilot range les
  jetons qu'il rafraîchit dans Secret Service, alors que la CLI Claude n'écrit que
  `.credentials.json`. Secret Service était lu en premier : après un nouveau
  `claude /login`, l'application gardait l'ancienne copie et son refresh token
  expiré, d'où un `invalid_grant` juste après chaque reconnexion. Les deux
  magasins sont désormais comparés et le jeton qui expire le plus tard l'emporte
  (`pickFresherCredentials`), pour les lectures complètes comme courtes (F116 de
  l'audit). Le bouton Reconnecter de la notification ouvre Réglages > Comptes et
  lance directement la connexion du provider.

### ✨ Nouveautés

- **Le wiki suit chaque release sans push à la main.** Les pages écrites à la
  main (nouveautés, feuille de route, sécurité) vivent comme patchs
  `git format-patch` dans `scripts/wiki/patches/`, relus en PR ; la synchro
  `full` que lance chaque release les applique au wiki avant de rafraîchir ses
  blocs `AUTOGEN`. Un patch déjà présent est sauté, un patch qui ne s'applique
  plus est nommé et fait échouer le job sans bloquer les autres (F115 de
  l'audit). Le contenu 1.3.1 du wiki passe par ce chemin.

---

## 1.3.2 - L'application démarre de nouveau

Correctif de la 1.3.1, dont le process principal d'Electron s'arrêtait au
chargement, et une reconnexion Claude qui atteint enfin le profil concerné.

### 🐛 Corrections

- **Le process principal plantait au démarrage** avec `SyntaxError: Identifier
  '__filename' has already been declared` (#536). electron-vite 6 ajoute en tête
  du bundle ESM ses propres `const __filename`, `const __dirname` et
  `const require` ; 24 modules de `src/main` déclaraient aussi les leurs, et l'un
  d'eux gardait son nom dans `out/main/index.js`. Le code du main lit désormais
  `import.meta.dirname` / `import.meta.filename` et ne déclare plus ces noms ;
  `esm-dirname.test.ts` le garde (F114 de l'audit).
- **La reconnexion Claude met à jour le bon profil** (#537). Un `claude /login`
  lancé dans un terminal écrit dans `~/.claude`, alors qu'un profil WorkPilot lit
  son propre `CLAUDE_CONFIG_DIR` : il gardait son jeton expiré et restait en
  « reconnexion requise ». Le bouton Reconnecter ouvre maintenant la connexion
  dans le terminal intégré, réglé sur le profil ; le drapeau de reconnexion
  tombe dès qu'un jeton valide est lu, et sur `invalid_grant` un login récent
  trouvé dans `~/.claude` est signalé, sans copier de jeton d'un dossier à
  l'autre.
- **La boucle de vérification relance proprement son aide UI Automation.**
  Après une requête restée sans réponse, l'aide tuée signalait sa fin dans la
  file de la suivante, qui passait pour « arrêtée » dès son démarrage ; chaque
  aide lit désormais dans sa propre file.

---

## 1.3.1 - La carte va jusqu'au bout, et l'effort annoncé est celui reçu

Onze features issues de la veille du 26 octobre (annexe G de
[`docs/audit/AUDIT-NETTOYAGE.md`](docs/audit/AUDIT-NETTOYAGE.md)), l'effort de
raisonnement enfin envoyé tel qu'il est affiché, et les lots M1 à M11 de l'audit
du 17 octobre : moins de surface d'attaque côté renderer, une CI qui garde ce qui
est livré, et les quatre fonctions géantes du backend découpées.

### ⚠️ Changement incompatible

- **Le démon « Continuous AI » est retiré** (#519). Son runner, ses canaux IPC,
  son store et ses réglages disparaissent ; ce qu'il faisait seul, hors de toute
  carte, passe par les **automatisations** ci-dessous, qui créent une carte que
  la personne voit.

### ✨ Nouveautés

- **La carte suit sa PR jusqu'au merge** (#514). Un check rouge (avec son
  journal) ou un fil de revue non résolu part au QA fixer, dans le worktree de
  la tâche, avec son provider, son modèle et son effort ; le commit est vérifié
  puis poussé, jamais en force. Aucun faux vert : une forge illisible est
  « inconnue », l'absence de check n'est pas un succès, un commit qui saute,
  supprime ou désactive un test est annulé. Le merge reste à une personne.
- **Mode objectif** (#515). Une carte peut porter une définition de « fini »
  exécutable : une commande, le code de sortie attendu, un plafond de passes et
  de dépense. Le QA continue tant que la commande échoue ; les tests et le
  script de la commande sont protégés, et le fichier d'objectif n'est
  inscriptible par aucun agent.
- **« Besoin de toi »** (#516). Une tâche qui attend (plan, revue, passage QA,
  erreur) le dit sur le bureau, et sur ntfy ou Telegram si on le veut. Un plan
  en attente s'approuve depuis Telegram par un bouton à usage unique, qui
  expire et qui est vérifié contre le chat configuré et l'état de la tâche. Un
  plan en attente de revue n'est plus annoncé comme un échec.
- **Traces OpenTelemetry GenAI pour tous les providers** (#517). Avec un
  endpoint OTLP, chaque provider émet les mêmes spans (`invoke_agent`, `chat`,
  `execute_tool`) avec les attributs `gen_ai.*`, sans prompt, sortie ni entrée
  d'outil. Un usage non rapporté est absent, pas nul.
- **Best-of-N** (#518). Une tâche construite 2 à 4 fois, chacune dans son
  worktree avec son provider, son modèle et son effort ; la carte classe les
  builds sur des chiffres (build terminé, QA, objectif, taille du diff, coût) et
  la personne garde celui qu'elle choisit.
- **Automatisations** (#519). Une règle (issue étiquetée, CI rouge sur une
  branche, horaire) crée une carte brouillon, une seule par issue ou par série
  rouge, sous un plafond quotidien. Une source illisible est nommée, jamais lue
  comme « rien de neuf ».
- **Agents ACP, Gemini CLI d'abord** (#522). Un client Agent Client Protocol
  pour tout agent déclaré par un bloc `acp:` de `capabilities/providers.yaml`.
  Les droits sont tenus trois fois (mode de session, demandes de permission,
  arrêt sur outil non déclaré) ; une question de l'agent apparaît sur la carte
  avec ses options. L'agent démarre dans le bac à sable de l'OS.
- **Bac à sable de l'OS** (#523). Les commandes de la boucle WorkPilot et des
  CLI OpenCode, pi et Gemini tournent sous bubblewrap (Linux) ou Seatbelt
  (macOS) : écritures confinées au worktree, identifiants cachés, réseau limité
  aux hôtes du provider et aux registres de paquets par un proxy filtrant qui
  nomme ce qu'il refuse. Sans bac à sable (Windows, Ubuntu sous AppArmor
  restrictif), la carte le dit au lancement ; `WORKPILOT_SANDBOX=required`
  refuse alors de démarrer.
- **MCP 2026-07-28 : tasks et MCP Apps** (#524). Les serveurs MCP de WorkPilot
  répondent aux deux générations du protocole ; les longs `verify_*` reviennent
  en tâches à un client qui déclare l'extension Tasks. Les vues qu'un outil
  attache s'affichent dans le panneau de la tâche, dans une iframe isolée
  derrière un pont qui refuse tout appel.
- **Banc de rejeu sur le dépôt** (#525). 10 à 20 cartes terminées sont
  reconstruites depuis le commit qui les précède, par chaque moteur choisi,
  dans une copie isolée, et jugées par les tests du commit d'arrivée, que
  l'agent ne voit jamais. Le tableau nourrit Formula Lab et laisse le routeur
  écarter un modèle que le banc a vu échouer sur au moins trois cartes.
- **Vérifier une application Windows par UI Automation** (#526). Une app WPF,
  WinForms ou WinUI non empaquetée est lancée et conduite par l'arbre
  d'accessibilité, jamais par une frappe simulée, dans la seule fenêtre que la
  carte nomme, cherchée dans l'arbre de processus lancé et épinglée par son
  handle.

### 🐛 Corrections

- **L'effort annoncé est celui que le modèle reçoit** (#513, lot M11). Grok,
  DeepSeek et Mistral reçoivent `reasoning_effort` sur les modèles qui le
  prennent ; OpenAI « none » et Gemini 2.5 Flash reçoivent vraiment « none » ;
  Ollama reçoit `think` quand le modèle le déclare ; un refus 400 de l'effort
  relance le tour une fois sans lui, et le fil de la tâche le dit. Le
  sélecteur d'effort affiche ce qui est réellement envoyé
  (`GET /providers/effort`).
- **Une app Windows lancée par la vérification ne meurt plus au démarrage**
  (#527). Sous Windows, `os.kill(pid, 0)` envoie Ctrl+C au groupe de processus
  au lieu de sonder le pid ; `foundation.platform.pid_is_running` interroge le
  processus sans le signaler. Un projet .NET dans un sous-dossier est lancé
  depuis le bon dossier.
- Des features qui ne disent que ce qu'elles ont fait (lot M3) : pas de PR
  Azure DevOps inventée en cas d'échec, une suite .NET rouge arrive au relecteur
  QA au lieu de « exécuté avec succès ».
- Les événements du Live Companion et de Context Mesh sont enfin écoutés, et
  les modales de limite de débit et d'échec d'authentification s'affichent
  (lots M7 et M8).

### 🔒 Sécurité

- **Aucune ligne de commande construite depuis le renderer ou un texte
  externe** (lot M1) : release GitHub sans shell, ouverture dans l'IDE ou le
  terminal liée à un projet connu, script Azure DevOps statique. L'app Windows
  empaquetée tourne en `asInvoker`.
- **Aucun identifiant stocké ne rejoint le renderer** (M5) : clés d'API, jetons
  OAuth et clés de provider sont masqués ; les tests de connexion tournent dans
  le main. Les journaux des runners sont expurgés, aucun `.env` n'est lu depuis
  le dossier de lancement, et les runners de forge démarrent sans les
  identifiants hérités du processus principal (#512).
- **Le renderer n'atteint que les projets enregistrés et les dossiers choisis**
  (lot M6), seule la page de l'app atteint un handler IPC, et les chemins
  d'outils (#511) comme le dossier du backend (#528) saisis dans les réglages
  sont vérifiés avant d'être exécutés.
- Mode hors-ligne strict pour `libdocs`, routes des providers refusées en mode
  serveur, `/health` réduit à son verdict (lot M4).
- CodeQL vert pour la release (#531) : tests de clé sur les URL autorisées
  seulement, clé Google en en-tête, hôte des remotes git comparé exactement,
  fichiers lus ou réécrits sans vérification préalable séparée, fichier
  temporaire du pair programming privé.

### 🛠️ Qualité

- **Une CI qui garde ce qui est livré** (lot M2) : déclencheurs sans liste
  blanche, une seule version de Biome, Python 3.12 testé, lockfile Python avec
  hashes, image serveur construite et migrée sur Postgres 16 en CI.
- **Contrats d'architecture** (lot M7) : chaque canal IPC nommé par sa
  constante et entendu des deux côtés, contrats d'import entre unités du
  backend, une ligne par vue dans `product-overview.md`.
- **Code mort retiré** (lot M8) : environ 17 800 lignes de modules qu'aucun
  code n'importait ; les vues expérimentales sont marquées et masquables.
- **Le cycle `core ⇄ agents` cassé et les fonctions géantes découpées** (lot
  M10) : `foundation/` sort de `core`, le plus grand cycle passe de 81 à 26
  unités ; `run_autonomous_agent`, la boucle QA, `create_client` et la fabrique
  de clients sont découpés sous des tests de caractérisation, sans changement
  de comportement.
- Doc et code alignés, palette de commandes traduite, jsdom à la demande (lot
  M9) ; `node-pty`, que rien ne chargeait, est retiré.
- Dépendances : Electron 45, electron-vite 6, chokidar 6, et les montées
  Dependabot de la semaine (FastAPI, SQLAlchemy, websockets, claude-agent-sdk,
  playwright, sentry-sdk, React, Vite).

---

## 1.3.0 - pi, filigranes retirés des fichiers générés, CI lisible

### ✨ Nouveautés

- **pi (pi.dev) est connu du dépôt et du cerveau** (lot 1 de
  [`docs/architecture/pi.md`](docs/architecture/pi.md)). Comme harness, pi lit
  `AGENTS.md` et `.agents/skills/` nativement, donc `capabilities/harnesses.yaml`
  le liste avec son vocabulaire d'outils et n'émet rien — aucune sortie de
  skills ne change. Comme agent du cerveau partagé, `brain/agents.py` sait où
  pi garde ses instructions (`~/.pi/agent/AGENTS.md`, ou `PI_CODING_AGENT_DIR`)
  et sa configuration MCP (`~/.pi/agent/mcp.json`) : `brain connect` et
  `bridge` le branchent comme les autres, sur `--apply`, après sauvegarde.
  La confiance qu'un projet demande à pi (`/trust`) reste une décision de la
  personne ; rien ici ne l'accorde. Les fixtures `tests/fixtures/pi/` sont six
  flux réels de pi 1.3.0 capturés sans secret (`capture.py`).
- **pi pilote une tâche** (lot 2 de [`docs/architecture/pi.md`](docs/architecture/pi.md)).
  Le provider **pi (CLI)** lance chaque phase dans `pi --mode json`, prompt sur
  stdin, événements JSON en retour, comme OpenCode. Les droits sont une
  allowlist réelle : la déclaration du type d'agent devient `--tools` dans les
  mots de pi, et un relecteur qui tente d'écrire reçoit `Tool write not found`.
  La session d'une tâche vit dans son dossier de spec et se reprend par id ;
  les skills du projet passent par `--skill .agents/skills` ; la confiance que
  pi demande pour `.pi/` (`/trust`) n'est jamais accordée à sa place, l'état
  est dit dans le fil de la tâche. Usage de chaque message mesuré dans le
  ledger du harness (`from_pi_usage`), `--thinking` depuis l'effort de la
  phase, badge **pi** dans la barre latérale, guide
  [`docs/integrations/pi.md`](docs/integrations/pi.md).
- **pi en mode RPC, et deux garde-fous** (lots 3 et 4). `WORKPILOT_PI_MODE=rpc`
  garde un processus pi par session : compaction à la demande, `abort` sur
  annulation, fenêtre du modèle lue dans `get_state`, prompt système envoyé
  une fois ; une question d'extension reçoit « annulé ». L'environnement de
  pi est construit (sans `NODE_OPTIONS`, `LD_*`, `DYLD_*`, clé JEV ni jeton
  OAuth de Claude Code), et un garde-fou d'écriture est chargé dans pi avec
  la politique de `security/path_guard` : hors du worktree, de la spec et du
  dossier temporaire, ou sur un fichier de garde-fous, un `write`/`edit` est
  refusé dans le processus pi lui-même — prouvé contre pi 1.3.0
  (`tests/fixtures/pi/guard-*.jsonl`). Un skill `tooling/pi` dit comment
  piloter pi sans interface (lot 5).

- **Les fichiers générés sortent propres.** Espaces de largeur nulle, espaces
  exotiques, contrôles bidirectionnels, caractères de balise : c'est ainsi qu'une
  marque de provenance voyage dans la sortie d'un modèle, et elle survit à chaque
  copier-coller vers un dépôt. Dans de la prose, c'est invisible et sans
  conséquence ; dans un fichier source, c'est une `SyntaxError` que personne ne
  voit, un identifiant qui ne s'égale pas lui-même, un `grep` qui ne trouve rien.
  La table de décision Unicode de
  [watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover)
  (MIT) est vendorisée et épinglée, et chaque `Write`, `Edit`, `MultiEdit` et
  `NotebookEdit` d'un agent y passe **avant** que les octets touchent le disque —
  côté SDK Claude comme côté fournisseurs qui ne l'utilisent pas. Ce qui est
  retiré est consigné dans `<spec_dir>/watermarks.jsonl` : c'est le seul endroit
  du produit où WorkPilot modifie silencieusement ce qu'un modèle a écrit, et une
  modification invisible se doit d'être traçable. Rien ne peut faire échouer une
  build : le coût sur un fichier propre est un `str.isascii()`. Réglages :
  `WATERMARKS_ENABLED`, `WATERMARKS_NORMALIZE_SPACES` (désactivé — l'espace
  insécable est porteur de sens en typographie française), `WATERMARKS_STRIP_BIDI`
  (durcissement Trojan Source), `WATERMARKS_MAX_BYTES`.

### 🛠️ Qualité

- **La CI nomme le test qui échoue.** Chaque ligne `FAILED` / `ERROR` du résumé
  de pytest devient une annotation du job (`ci.yml`), lisible sans le journal
  brut (#468). Première prise : le test du journal d'un RUN demandait au shell
  d'étendre `$RUN_API_TOKEN`, ce que `cmd.exe` ne fait pas ; il parle désormais
  la syntaxe du shell de la plateforme (`%VAR%` sous Windows), et le job Windows
  repasse au vert.

---

## 1.2.1 - La build macOS Intel, et la chaîne de release qui la publie

La 1.2.0 annonçait six plateformes et n'en livrait que cinq. Cette version
existe d'abord pour livrer la sixième, et pour que le cas ne puisse pas se
reproduire silencieusement.

### 🐛 Corrections

- **La build macOS Intel manquait purement et simplement.** `package:mac` codait
  `--arm64` en dur, alors que les quatre appels du dépôt passent déjà une
  architecture explicite : le job « Intel » lançait
  `electron-builder --mac --arm64 --x64` et packageait de l'arm64 sur un runner
  `macos-15-intel`. Les deux jobs macOS produisaient le même binaire. Les
  utilisateurs de Mac Intel n'avaient rien à télécharger, et le lien du README
  renvoyait un 404.
- **Le README annonçait des plateformes non construites.** Le tableau de
  téléchargement était un modèle figé de six lignes dans lequel on substituait
  le numéro de version — jamais régénéré, donc une ligne périmée survivait de
  release en release. Il est désormais construit depuis les assets réellement
  attachés à la release : une plateforme absente est omise **et** signalée en
  `::warning::`, et une release sans aucun asset rend une phrase plutôt que six
  liens morts.
- **Le wiki ne se rafraîchissait jamais.** `wiki-narrative.yml` écoute
  `release: published`, mais un événement émis par `GITHUB_TOKEN` ne déclenche
  aucun workflow — la même règle qui empêchait déjà un tag de lancer sa release.
  `create-release` le dispatche maintenant explicitement.
- Un push wiki refusé faute de token rend un message actionnable au lieu d'une
  traceback, et n'échoue le job que si le sync était réellement configuré.

### 🔒 Sécurité

- **`py/stack-trace-exposure` sur le test de webhook** (alerte 74), restée
  ouverte après une première correction incomplète. La réponse ne dérive plus
  d'une exception : chaque motif de rejet est lu dans une table de littéraux,
  sur le modèle de `workflows/api.py`. L'appelant y gagne au passage un
  diagnostic précis — URL vide, schéma refusé, hôte irrésolvable, plage privée —
  là où tout était aplati en « Invalid input ».

### 🛠️ Coûts et dépendances

- **Le rafraîchissement narratif du wiki ne se repaie plus lui-même.** Une
  empreinte des documents sources garde la passe : une release qui ne touche ni
  `README.md`, ni `docs/CLAUDE.md`, ni `docs/CLI-USAGE.md` ne régénère plus une
  prose identique. Le modèle passe de `claude-sonnet-4-6` à `claude-sonnet-5`,
  plus récent **et** moins cher. Sur dix releases dont deux touchent la
  documentation, le coût passe d'environ 10,60 $ à 1,41 $.
- Dix montées de dépendances (claude-agent-sdk, alembic, h2, aiosqlite, psutil,
  vitest, autoprefixer, xstate, lucide-react, @uiw/codemirror-theme-vscode).

---

## 1.2.0 - Workflows déclaratifs, skills agnostiques et durcissement

Le moteur de workflow décide désormais réellement ce qui tourne, les skills
deviennent un standard partagé entre harnesses, et la surface HTTP du backend
cesse de renvoyer ses exceptions à l'appelant.

### ✨ Workflows déclaratifs

- **Le moteur exécute les phases qu'il déclare**, au lieu de seulement les élaguer — `workflows/<nom>/workflow.yaml` résout un build contre le niveau d'effort choisi, les capacités du provider et les fichiers touchés. **Activé par défaut** (`WORKPILOT_WORKFLOW_ENGINE=0` pour revenir au pipeline précédent).
- **Le profil résolu est visible avant le build**, dans le modal de tâche (`WorkflowProfileCard`) : les phases élaguées apparaissent à leur position déclarée avec leur motif, et un décompte par niveau répond à « qu'est-ce qu'un cran de plus m'apporterait ».
- Une phase demandant `subagent-per-task` chez un provider sans sous-agents **dégrade explicitement** en séquentiel avec reset de contexte, et la dégradation est lue à l'exécution plutôt que supposée.
- Un `hard_gate` n'est jamais élagué par l'effort ; une phase déterministe non plus, puisqu'elle ne coûte aucun appel API.

### ✨ Skills, sous-agents et boucle d'apprentissage

- **Skills au standard [Agent Skills](https://agentskills.io)** — `.agents/skills/<nom>/SKILL.md` est la source lue en production, quel que soit le LLM ; les miroirs par harness sont générés, et `pnpm run skills:check` échoue sur toute dérive.
- **Une seule lecture de frontmatter** (`skills_registry.frontmatter`) : le dépôt en portait quatre, dont trois tronquaient toute description finissant par une phrase entre guillemets.
- **Registre unique de sous-agents** (`agents/subagents/`) : défauts de phase, overlays langage et spécialistes de PR.
- **`mem-search`** — récupération progressive en trois paliers sur les traces de build et les patterns : l'index tient dans ~100 tokens et ne lit jamais le corps d'un enregistrement pour le lister.
- **hermes-agent** est supporté sans rien dupliquer : il lit le même `.agents/skills/`, et les skills qu'il rédige arrivent comme *candidats* sous `skills/_proposed/` — jamais adoptés automatiquement, faute de signal de vérification externe.

### 🔒 Sécurité

- **Les 141 alertes de code scanning traitées.** 132 étaient deux erreurs répétées une fois par module d'API, désormais corrigées à la source dans `core/api_safety.py` : `safe_error` mappe une exception vers une chaîne fixe par type, `validated_dir` normalise et confine un chemin fourni par l'appelant.
- `return {"success": False, "error": str(e)}` renvoyait à l'appelant des chemins résolus, des erreurs de driver et parfois des secrets — 99 sites corrigés.
- Le middleware d'auth du mode serveur ne distingue plus token expiré, malformé ou mal signé pour un appelant non authentifié.
- **Parsing XML durci** (`defusedxml`) : `coverage.xml` et le XML JUnit sont lus dans le dépôt en cours de build, donc contrôlés par un tiers.
- Fuite de secret en clair dans un log, ReDoS polynomial sur le parseur de licences, et sanitisation d'URL incomplète : corrigés.
- Toutes les alertes Dependabot ouvertes closes (esbuild `GHSA-g7r4-m6w7-qqqr`, @babel/core `GHSA-4x5r-pxfx-6jf8`).
- Mode serveur **fail-closed**, endpoints de credentials verrouillés, IDOR d'annulation de run et révocation de session corrigés, Electron patché, interpolation shell supprimée.

### 🐛 Corrections

- **`GET /api/workflow-profile/` répondait à personne** : un autofix CodeQL avait confiné `project_dir` au dépôt WorkPilot, alors que WorkPilot construit les projets *des autres*. Dix tests rouges et un panneau de tâche vide.
- Les libellés du menu latéral portaient des emoji qui ne s'affichaient pas.
- `bump-version.js` réécrivait les manifestes entiers en espaces alors que le dépôt indente en tabulations — une montée de version de deux lignes produisait un diff de 530 lignes.
- Assistant de configuration : projet introuvable et avance automatique.
- BOMs UTF-8 et un fichier UTF-16 nettoyés ; hooks husky réparés ; `aiohttp` déclaré.

### 🛠️ Qualité

- **CodeQL ne scanne plus C#** : les 3 seuls fichiers `.cs` du dépôt sont des extraits de documentation livrés par un skill, sans projet ni restore — l'analyse stagnait à 22 % d'appels résolus et la configuration restait en warning permanent.
- Les templates Angular qu'un formateur avait rendus incompilables sont restaurés et sortis de l'extension `.ts`, qu'ils n'auraient jamais dû porter.
- Actions tierces épinglées sur des SHA de commit ; Dependabot npm repointé sur la racine du workspace, où vit réellement le lockfile pnpm.

---

## 1.1.0 - Multi-Provider, Formula Lab & Autonomous Agents

A large feature release: WorkPilot AI is now fully provider-agnostic, gains
mid-task execution control, a cost/success estimation lab, and a wave of new
autonomous agents and integrations. 150+ features and 150+ fixes since 1.0.0.

### ✨ Multi-Provider & Model Support

- **Provider-agnostic pipeline** — drive every phase with Claude, OpenAI, Gemini, Grok, GitHub Copilot, Azure OpenAI, a local Ollama model, or any OpenAI-compatible endpoint.
- **Provider-neutral one-shot core** so title/terminal-name/spec-interview/visual-proof no longer assume Claude.
- **Provider-neutral conversation log** (JSONL) that is replayed into the next provider on resume.
- **Live + static model catalogs** unioned per provider, with provider-aware model selection.
- New models across catalogs: **Claude Opus 4.8**, Opus 4.7, **Fable 5**, plus Anthropic versioned models.
- **Centralized model registry** shared across backend modules.

### ✨ Execution Control

- **Hot-Swap LLM** — change provider, model, or reasoning effort mid-task; context is replayed onto the new engine on the next turn.
- **Pause & Resume** across all task statuses and Kanban cards, with provider switch on resume ("Reprendre avec…").
- **Per-phase re-run** — redo planning, coding, or validation on demand.
- **Execution formula gate** before starting a task.

### ✨ Kanban & Task Workflow

- **Formula Lab** — pre-flight cost/success estimation per Provider × Model × Effort, calibrated on real usage history, with EUR pricing, sortable comparison table, and a hybrid "Refine with AI" pass.
- **PR-first guided human review**, plus "approve & close" and reversible task abandon.
- Chip-based filter panel, task duplication, Quick Command Bar, previous/next task navigation, per-task phase indicator, and Kanban column selection from the task pop-in.
- Acceptance criteria imported from Azure/Jira and grouped by scenario.

### ✨ New Agents & Intelligence

- **Consensus Arbiter** — reconciles conflicting security/QA opinions into one verdict.
- **Agent Coach** — cost/model coaching from real usage.
- **Carbon Profiler** — energy (kWh) and carbon footprint of agent runs.
- **Release Coordinator** and a **Technical Debt** dashboard.
- **Flaky Test Detective**, **Virtual Reviewer**, **Blast Radius**, **Bounty Board**, loop detection, and self-review modules.
- **Agent Debugger** with persistent state and breakpoints, plus Agent Replay.

### ✨ Testing

- **Live / streaming test generation** surface.
- **.NET test automation**, target-test generation, strict/per-task **TDD mode**, and in-UI plan editing.

### ✨ Visual & Design

- **Design-to-Code** service and a **visual programming canvas** (architecture drawing → scaffold).
- **Visual proof** with automated screenshot capture, feature navigation, window-only capture, and PR-comment integration.
- **App Emulator** embedded in the task modal.

### ✨ Onboarding

- **Setup Hub** post-install checklist and a step-by-step **guided tour** (coachmarks), plus guardrails.

### ✨ Integrations & Collaboration

- **Multi-user server mode** — central deployment with JWT / Microsoft Entra auth, per-user claims, run manager, and invitation-only signup.
- **Azure DevOps authentication** for worktree operations; inline Azure/Jira images and richer work-item retrieval.
- **Slack / Teams bots**, real Self-Healing alert channels (Slack / email / GitHub), and Windsurf integration improvements.

### ✨ Memory, Analytics & Optimization

- **Graphiti memory integration** and a continuous **learning loop**.
- **Usage-tracking dashboard**, cost predictor, and cost estimator.
- **LLM token optimization** (system prompt, effort mapping, prompt caching, context compaction).
- **Smart-merge / rebase protection** for `.workpilot` preservation.

### 🔐 Security

- Audit-trail encryption, hardened security validation and sandbox approval, injection guard, license governance, and SSRF hardening on outbound webhooks.

### 🐛 Bug Fixes & Stability

- 150+ fixes, including Windows startup-freeze fixes (synchronous Credential Manager and subprocess spawns moved off the main thread), credential utilities, browser mock, streaming/WebSocket reconnection, worktree data-loss protection, and numerous i18n and UI corrections.

### 📚 Documentation

- Refreshed root, backend, and frontend READMEs with the latest features; corrected stale module paths; and updated the public wiki.

---

## 1.0.0 - Initial WorkPilot AI Release

Initial public release. The complete 1.0.0 feature list is in the
[git history](https://github.com/krovomi/WorkPilot-AI/blob/f385fe1/docs/CHANGELOG.md).
