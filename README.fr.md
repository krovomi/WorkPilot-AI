# WorkPilot AI

[English](README.md) · **Français**

**Décrivez ce que vous voulez construire. Une chaîne d'agents IA le planifie, le code, le teste et ouvre la pull request — chaque tâche dans son propre worktree git, avec le provider d'IA de votre choix.**

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/krovomi/WorkPilot-AI?style=flat-square&label=release)](https://github.com/krovomi/WorkPilot-AI/releases/latest)
[![Discussions](https://img.shields.io/github/discussions/krovomi/WorkPilot-AI?style=flat-square&logo=github&label=discussions)](https://github.com/krovomi/WorkPilot-AI/discussions)
[![Wiki](https://img.shields.io/badge/docs-wiki-blue?style=flat-square&logo=github)](https://github.com/krovomi/WorkPilot-AI/wiki)
[![CI](https://img.shields.io/github/actions/workflow/status/krovomi/WorkPilot-AI/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/krovomi/WorkPilot-AI/actions)

![WorkPilot AI : le tableau Kanban, où les agents planifient, codent et relisent les tâches](.github/assets/showcase/kanban.png)

**[Télécharger](#télécharger)** · **[Démarrage rapide](#démarrage-rapide)** · **[Fonctionnement](#fonctionnement)** · **[Visite](#visite-de-lapplication)** · **[Features](#les-features-en-bref)** · **[Providers d'IA](#providers-dia)** · **[Documentation](#documentation)**

WorkPilot AI est une application de bureau (Windows, macOS, Linux) avec un moteur Python, un serveur d'équipe optionnel et une app mobile. Elle fonctionne sur toutes les stacks : .NET, Java, Kotlin, Go, Rust, Python, Node.js et TypeScript (Angular, React, Vue, Next.js, Nuxt…), PHP, Ruby, Flutter, Swift, WinDev et d'autres.

> Les captures montrent l'interface en anglais ; l'application est entièrement disponible en français (Paramètres > Langue).

---

## Télécharger

### Version stable

<!-- STABLE_VERSION_BADGE -->
[![Stable](https://img.shields.io/badge/stable-1.6.1-blue?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases/tag/v1.6.1)
<!-- STABLE_VERSION_BADGE_END -->

<!-- STABLE_DOWNLOADS -->
| Plateforme | Téléchargement |
|------------|----------------|
| **Windows** | [WorkPilot-AI-1.6.1-win32-x64.exe](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-win32-x64.exe) |
| **macOS (Apple Silicon)** | [WorkPilot-AI-1.6.1-darwin-arm64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-darwin-arm64.dmg) |
| **macOS (Intel)** | [WorkPilot-AI-1.6.1-darwin-x64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-darwin-x64.dmg) |
| **Linux** | [WorkPilot-AI-1.6.1-linux-x86_64.AppImage](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-linux-x86_64.AppImage) |
| **Linux (Debian)** | [WorkPilot-AI-1.6.1-linux-amd64.deb](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-linux-amd64.deb) |
| **Linux (Flatpak)** | [WorkPilot-AI-1.6.1-linux-x86_64.flatpak](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.6.1/WorkPilot-AI-1.6.1-linux-x86_64.flatpak) |
<!-- STABLE_DOWNLOADS_END -->

### Version bêta

> Les versions bêta peuvent contenir des bugs et des changements incompatibles. [Toutes les versions](https://github.com/krovomi/WorkPilot-AI/releases)

<!-- BETA_VERSION_BADGE -->
[![Beta](https://img.shields.io/badge/beta-none%20published-lightgrey?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases)
<!-- BETA_VERSION_BADGE_END -->

<!-- BETA_DOWNLOADS -->
_Aucune version bêta n'est publiée pour le moment. Le tableau ci-dessus est la dernière version stable._
<!-- BETA_DOWNLOADS_END -->

> Chaque version contient les sommes de contrôle SHA256, un SBOM CycloneDX (`workpilot-sbom.cdx.json`) et une attestation de provenance de build pour chaque fichier (`gh attestation verify <fichier> --repo krovomi/WorkPilot-AI`) ; les résultats d'analyse VirusTotal sont ajoutés aux notes de version quand l'analyse est configurée.


---

## Démarrage rapide

1. **Installez** l'application pour votre plateforme depuis le [tableau de téléchargement](#télécharger).
2. **Ouvrez un projet** : n'importe quel dossier qui est un dépôt git.
3. **Connectez un provider d'IA** : un abonnement Claude, une clé d'API (OpenAI, Gemini, Grok, Mistral, DeepSeek), GitHub Copilot, un modèle local (Ollama, LM Studio) ou un agent CLI (Codex, OpenCode, pi…).
4. **Créez une tâche** sur le tableau Kanban et décrivez ce que vous voulez.
5. **Relisez le résultat** : les agents planifient, codent et valident ; vous approuvez le plan si vous le souhaitez, puis vous relisez le diff et fusionnez.

Depuis les sources (Node.js 22.12+, pnpm, Python 3.12+, Git) :

```sh
git clone https://github.com/krovomi/WorkPilot-AI.git
cd WorkPilot-AI
pnpm install
pnpm run dev
```

Installation pas à pas, configuration des providers, notes Windows et dépannage : [docs/INSTALLATION.md](docs/INSTALLATION.md).

---

## Fonctionnement

<a href=".github/assets/showcase/how-it-works.fr-light.png">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/showcase/how-it-works.fr-dark.png">
  <img alt="Fonctionnement : planifier (vous décrivez une tâche, spec, planificateur, vous validez), construire et contrôler (codeur, relecteur et correcteur QA jusqu'à l'accord de la QA), prouver et livrer (vérification, vous relisez le diff, fusion ou pull request)" src=".github/assets/showcase/how-it-works.fr-light.png" width="100%">
</picture>
</a>

- **Isolé** : chaque tâche tourne dans son propre worktree git, votre branche reste intacte jusqu'au merge ; le worktree est supprimé une fois la pull request de la tâche fusionnée.
- **Toujours relu** : les pages qui écrivent du code (studio de tests, Import Design, journal des modifications, pair programming, commandes rapides du Kanban) le déposent sur la branche d'une carte « Code généré » en Révision humaine ; il n'atteint votre projet que par une pull request que vous relisez ([code généré](docs/architecture/generated-review.md)).
- **Un workflow par type de tâche** : un bug est reproduit avant d'être corrigé, une investigation écrit un rapport et aucun code, un refactoring n'a pas le droit de toucher aux tests, un hotfix reçoit une revue indépendante ([types de tâches](docs/architecture/kanban-task-types.md)).
- **De petites pull requests** : une tâche qui dépasse le plafond de revue de son type se découpe d'elle-même en parties, une petite PR chacune, empilées quand elles dépendent l'une de l'autre ([découpage des tâches](docs/architecture/task-split.md)).
- **Des preuves, pas des avis** : après la QA, l'application modifiée par la tâche est lancée et pilotée (web, Electron, émulateur mobile, API, bureau Windows), et des portes strictes vérifient les dépendances ajoutées et que les tests détectent vraiment les défauts.
- **N'importe quel moteur** : changez de provider, de modèle ou d'effort par tâche, même en cours de route ; ce que chaque provider sait faire est déclaré dans [`capabilities/providers.yaml`](capabilities/providers.yaml).

---

## Visite de l'application

> Chaque capture vient de la vraie application, remplie avec un projet de démonstration inventé (`acme-storefront`), et est régénérée par [`scripts/readme-screenshots/`](scripts/readme-screenshots/).

**Tableau Kanban** (ci-dessus) : décrivez une tâche et suivez-la de la planification jusqu'à la pull request. Chaque carte montre sa phase, son avancement, le provider au travail et son sujet ; les parties d'une tâche découpée partagent une couleur et une marque « Partie k/N ». Les colonnes suivent le pipeline : Planification, File d'attente, En cours, Révision IA, Révision humaine, PR ouverte (tant qu'une pull request attend sa fusion), Terminé, plus Build rouge quand la CI du projet échoue sur la branche d'une tâche. La barre d'outils tient sur une ligne ; son menu « ⋯ » contient **Multi-dépôts** (un changement sur plusieurs dépôts) et **Purger** (libère la place prise par les worktrees des cartes terminées). Chaque carte prend la couleur de son type (fonctionnalité, correction, refactorisation, sécurité… 14 types, aucun champ à remplir) et montre un aperçu au survol ; une carte terminée indique le temps des agents, les tokens et le coût, qui l'a créée et qui l'a lancée. Les cartes s'ajoutent vite depuis Planification, File d'attente ou En cours (une par ligne collée ; « + » dans En cours la crée et la démarre), se modifient par un clic droit, se sélectionnent avec Ctrl ou Maj pour des actions en masse et se glissent ensemble, se renomment en place (F2), et une suppression se reprend avec Ctrl+Z. L'en-tête de chaque colonne est un bandeau à sa couleur avec son compteur, une jauge de capacité et une ligne de résumé. Avant le premier démarrage d'une carte, la machine est vérifiée (git, commit, compte) et une carte courte est relue une fois par l'IA, qui peut poser jusqu'à trois questions et ne bloque jamais le départ ([édition rapide](docs/architecture/kanban-quick-edit.md), [couleurs des cartes](docs/architecture/kanban-card-colors.md), [colonnes](docs/architecture/kanban-columns.md), [faits d'exécution](docs/architecture/task-run-facts.md), [préparation](docs/architecture/task-readiness.md)).

**Reprendre ce qu'une fermeture ou un plantage a interrompu** ([pause et reprise](docs/architecture/pause-resume.md)) : fermer WorkPilot met en pause les tâches qui tournent, et le démarrage suivant demande lesquelles reprendre. Chacune montre son projet, son provider et son modèle, la façon dont elle s'est arrêtée (fermeture, plantage, ou « Arrêter tous les agents ») et où elle repartira : la phase, et pendant le code la prochaine sous-tâche. Ce que l'app a interrompu est coché, ce que vous avez arrêté ne l'est pas, et une tâche dont la reprise échouerait tout de suite (connexion Claude expirée pour une tâche sur Claude, dossier de spec disparu) est décochée avec la raison. Les reprises respectent la limite « En cours » de chaque projet, les autres partent quand une place se libère. « Plus tard » les laisse en pause : leur carte affiche **Interrompue**, jamais « Bloqué », avec un bouton Reprendre, et « N tâches interrompues · Reprendre… » dans la barre du Kanban rouvre la liste. Paramètres > Paramètres d'agent : Me demander (par défaut), Tout reprendre ou Ne rien reprendre.

**Avec un serveur d'équipe.** Un run qui tournait quand le serveur d'équipe a redémarré s'affiche **Interrompu**, pas échoué, et la même invite le liste : dans l'app de bureau au démarrage ou à la connexion, et dans l'app mobile une fois connecté. Vos runs sont cochés ; un propriétaire du projet voit aussi ceux de l'équipe, décochés, avec qui les a lancés. Reprendre relance la même phase avec le même modèle et les mêmes droits que Démarrer (un build parti approuvé garde son approbation) ; Plus tard les met de côté sur le serveur, donc aucun autre appareil ne les repropose.

<table>
<tr>
<td width="50%" valign="top">

<a href=".github/assets/showcase/interrupted-tasks.png">
<picture>
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/showcase/interrupted-tasks-light.png">
  <img alt="Au démarrage : les tâches interrompues, chacune avec son moteur, sa façon de s'arrêter et l'étape où elle repart, cochées par défaut" src=".github/assets/showcase/interrupted-tasks.png">
</picture>
</a>

</td>
<td width="50%" valign="top">

<a href=".github/assets/showcase/interrupted-cards.png">
<picture>
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/showcase/interrupted-cards-light.png">
  <img alt="Le tableau : cartes Interrompue avec Reprendre, « 2 interrompues » sur le bandeau En cours et « 3 tâches interrompues · Reprendre… » dans la barre" src=".github/assets/showcase/interrupted-cards.png">
</picture>
</a>

</td>
</tr>
</table>

**Tableau agile, comme Jira** ([sprints](docs/architecture/kanban-sprints.md), [couloirs](docs/architecture/kanban-swimlanes.md), [liste](docs/architecture/kanban-list-view.md), [frise](docs/architecture/kanban-timeline.md), [rapports](docs/architecture/kanban-reports.md)) : les tâches qui finissent sans succès ont leurs colonnes, **Échec** et **Abandonnée** (avec la raison : doublon, ne sera pas fait, PR fermée…), et une tâche peut être marquée **Bloquée** avec ce qui la bloque. Planifiez en **sprints** (démarrage, clôture avec report, points issus de Smart Estimation, jamais une durée), coupez le tableau en **couloirs** par sprint, sous-projet, priorité, type, source ou tâche parente, et passez de **Tableau** à **Liste** (colonnes triables) ou **Frise** (chaque tâche de son début à sa fin, les sprints en tête). Les **Rapports** tracent le burndown, la vélocité, le flux cumulé, le temps de cycle, le débit et les fins non abouties. **Étiquettes**, filtres rapides (Bloquées, Modifiées cette semaine, Mes tâches sur un serveur d'équipe) et vues enregistrées gardent le tableau lisible ; les tâches terminées peuvent s'archiver d'elles-mêmes après 7, 14 ou 30 jours.

**Planifier et proposer un sprint** ([planification](docs/architecture/kanban-sprints.md), [proposition](docs/architecture/sprint-proposal.md)) : « Planifier » met le backlog et le sprint côte à côte, avec une jauge de capacité en points face à la vélocité des 3 derniers sprints (disponibilité de l'équipe en %, une cible de 20 points pour un premier sprint). Glissez les tâches d'un côté à l'autre ou appuyez sur → / ←, annulez le dernier déplacement, filtrez le backlog (urgentes, bugs, non estimées) et « Estimez » une tâche sans points ; les tâches reportées et celles qui attendent une tâche restée au backlog sont signalées. **Proposer le sprint** le remplit jusqu'à sa capacité : les règles classent le backlog et ajoutent d'abord ce qu'une tâche attend, le modèle du provider choisi compose le sprint et donne une raison par tâche, et les meilleures tâches qui ne tiennent pas restent sous la ligne. Variantes : Équilibré, Plus prudent (80 %), Bugs d'abord, Autour du but ; un but est suggéré quand le sprint n'en a pas. Rien ne bouge avant que vous ajoutiez les tâches, et cela marche aussi sans modèle. Le modèle ne lit que le titre d'une tâche, le début de sa description, sa priorité, son type, ses points, ses étiquettes et ses dépendances, jamais qui travaille dessus.

<table>
<tr>
<td width="50%" valign="top">

<a href=".github/assets/showcase/sprint-planning.png">
<picture>
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/showcase/sprint-planning-light.png">
  <img alt="Planifier un sprint : la jauge de capacité face à la vélocité des 3 derniers sprints, le backlog et le sprint côte à côte" src=".github/assets/showcase/sprint-planning.png">
</picture>
</a>

</td>
<td width="50%" valign="top">

<a href=".github/assets/showcase/sprint-proposal.png">
<picture>
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/showcase/sprint-proposal-light.png">
  <img alt="Proposer le sprint : les tâches proposées en pointillés violets avec leur raison, la ligne de capacité et ce qui passe dessous" src=".github/assets/showcase/sprint-proposal.png">
</picture>
</a>

</td>
</tr>
</table>

**Interroger le tableau** ([interroger le tableau](docs/architecture/board-ask.md)) : posez une question dans n'importe quelle langue (« l'export CSV a-t-il déjà été fait ? ») et obtenez tous les tickets liés, avec la feuille de route, les idées et les changements fusionnés, trouvés par les mots et par le sens (un modèle d'embeddings local d'abord) et jugés par le modèle du provider choisi ; « Vérifier une idée » dit si une fonctionnalité prévue est déjà sur le tableau. Il répond sur un tableau local, sur celui d'un serveur d'équipe depuis le bureau, et depuis le téléphone.

<table>
<tr>
<td width="50%" valign="top">

![Couloirs par sprint : le couloir des tâches bloquées en premier, puis le Sprint 12 avec ses colonnes](.github/assets/showcase/kanban-lanes.png)

</td>
<td width="50%" valign="top">

![Vue liste par sprint : statut, priorité, sprint, sous-projet, points et dernière mise à jour](.github/assets/showcase/kanban-list.png)

</td>
</tr>
<tr>
<td valign="top">

![Frise : une barre par tâche du début à la fin, la ligne du jour et les dates des sprints](.github/assets/showcase/kanban-timeline.png)

</td>
<td valign="top">

![Rapports : le burndown du Sprint 12, points restants face à la ligne idéale](.github/assets/showcase/kanban-reports.png)

</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">

**Détail d'une tâche** : le plan découpé en sous-tâches avec les fichiers que chacune touche, les logs, les fichiers modifiés, les preuves visuelles et l'émulateur.

![Détail d'une tâche et ses sous-tâches](.github/assets/showcase/task-detail.png)

</td>
<td width="50%" valign="top">

**Terminaux d'agents** : jusqu'à 12 terminaux côte à côte, chacun dans le worktree d'une tâche, pour lancer des agents en parallèle à la main.

![Terminaux d'agents : deux sessions côte à côte](.github/assets/showcase/terminals.png)

</td>
</tr>
<tr>
<td valign="top">

**Insights** : posez vos questions sur le code ; les réponses citent fichiers et lignes, et une trouvaille devient une tâche en un clic.

![Insights : une conversation sur le code qui se termine par une tâche suggérée](.github/assets/showcase/insights.png)

</td>
<td valign="top">

**Feuille de route** : vision produit, phases, priorités MoSCoW, concurrents et votes ; toute feature devient une tâche avec **Construire**.

![La feuille de route en Kanban de features](.github/assets/showcase/roadmap.png)

</td>
</tr>
<tr>
<td valign="top">

**Idéation** : les agents parcourent le projet et proposent des améliorations par type, chacune avec sa justification et ses fichiers.

![Idéation : idées d'amélioration par type](.github/assets/showcase/ideation.png)

</td>
<td valign="top">

**Tableau de bord** : ce que les agents produisent et coûtent, par statut, provider et modèle ; exportable en JSON ou CSV.

![Tableau de bord des métriques du projet](.github/assets/showcase/dashboard.png)

</td>
</tr>
<tr>
<td valign="top">

**Visuel vers Code** : dessinez l'architecture en graphe de nœuds, chaque liaison expliquée et vérifiée, puis générez le projet.

![Visuel vers Code : une architecture dessinée en graphe de nœuds, chaque liaison expliquée](.github/assets/showcase/visual-to-code.png)

</td>
<td valign="top">

**Import Design** : une maquette, une capture ou un export Figma devient des composants de la stack du projet, en six étapes visibles.
Le code est ensuite rendu, comparé à la maquette et corrigé jusqu'à lui ressembler, dans les itérations, le seuil et le budget en jetons ou en coût choisis, avec le score de chaque itération et les écarts restants ; sur demande, la version retenue est aussi contrôlée en mobile, tablette et bureau, et au survol et au focus, et ce que ces contrôles trouvent peut être renvoyé pour une correction de plus ; les zones tracées sur la maquette sont exclues du score, et la page garde sur cet ordinateur les chiffres de la boucle sur le projet (score moyen, corrections pour converger, écritures gardées sans retouche) ([boucle de rendu](docs/architecture/design-render-loop.md)).

![Import Design : les six étapes d'une image aux composants du projet](.github/assets/showcase/import-design.png)

</td>
</tr>
<tr>
<td valign="top">

**Studio de génération de tests** : trous de couverture, tests unitaires, E2E ou TDD, écrits en direct dans le framework de la stack du fichier.

![Studio de génération de tests : cible, pipeline en quatre étapes et résultat en direct](.github/assets/showcase/test-generation.png)

</td>
<td valign="top">

**Paramètres** : réglages de l'application et du projet regroupés par thème, dans la même charte graphique que tous les modules, aux couleurs du thème actif.

![Paramètres : navigation par groupes et la page générale du projet](.github/assets/showcase/settings.png)

</td>
</tr>
<tr>
<td valign="top">

**Comptes IA** : tous les providers sur une page, avec leur mode de connexion, s'ils répondent, leur usage et l'âge de leur clé ; une tâche arrêtée par une limite reprend sur le compte suivant de la chaîne de basculement, quel que soit le provider.

![Comptes IA : providers connectés, provider par défaut et basculement automatique](.github/assets/showcase/ai-accounts.png)

</td>
<td valign="top">

**Bac à sable** : un instantané du worktree de la tâche avant chaque session d'agent, restauré quand la surveillance des anomalies arrête une session ; mode d'écriture restreint et limites par session.

![Réglages du bac à sable : instantanés et retour arrière, mode d'écriture, limites par session](.github/assets/showcase/sandbox.png)

</td>
</tr>
<tr>
<td valign="top">

**Migration de code** : analysez une migration de framework, de version ou de langage sur n'importe quelle stack, lisez ses phases, ses étapes et son risque, puis confiez le plan à une tâche Kanban.

![Migration de code : de React 18 à React 19, les phases prévues et le risque](.github/assets/showcase/code-migration.png)

</td>
<td valign="top">

**Votre propre menu** : glissez une page sur un autre espace ou réordonnez vos épingles, ou passez par « Personnaliser le menu » au clavier ; le menu se redimensionne et, sur un serveur d'équipe, vous suit sur chaque poste.

![Personnaliser le menu : poignées et flèches pour réordonner les pages épinglées](.github/assets/showcase/menu-customize.png)

</td>
</tr>
</table>

**App mobile (iOS et Android)** : avec un serveur d'équipe, le tableau partagé dans votre poche : ouvrir une carte, approuver un plan, régler sa criticité ou prêter son approbation, lancer ou arrêter les agents, lire le tableau de bord, les Insights, la feuille de route et les idées ; se connecter par mot de passe, Microsoft Entra ou l'authentification unique du serveur. Chaque projet s'ouvre sur des onglets (tableau, Insights, forge, tableau de bord, plus), et les sept thèmes de couleur du bureau, en clair ou en sombre, suivent votre compte d'un appareil à l'autre. « Pour vous » rassemble ce qui vous attend dans tous vos projets, et le serveur peut aussi vous prévenir sur ntfy, Telegram ou Teams. Le chat d'équipe, le classement (seuls ceux qui l'acceptent y sont nommés) et vos liens de replay vous suivent aussi, et une carte s'ouvre en profondeur : tout son journal en direct, chaque fichier modifié en plein écran, votre avis sur les constats de la revue IA, et la mémoire du projet à épingler, oublier ou remettre. Les administrateurs y trouvent aussi la vue d'ensemble de l'organisation, ses quotas, son journal d'audit et ses sessions.

![App mobile : le tableau en Default clair, une carte en Default sombre, le tableau de bord en Ocean clair et les réglages d'apparence en Forest sombre](.github/assets/screenshots/mobile.png)

---

## Les features en bref

La liste complète, avec chaque détail, est dans **[docs/FEATURES.md](docs/FEATURES.md)** (en anglais). Les vues marquées _expérimentales_ (une fiole sur leur icône) n'ont pas encore de document de conception ni de test ; elles sont réunies dans le **Labo** du menu, la fiole en bas du rail, et un bouton les masque toutes.

**Pipeline de construction**
- **Tableau Kanban** avec approbation de la spec, pause et reprise (et, au démarrage, le choix des tâches qu'une fermeture ou un plantage a interrompues à reprendre), relance par phase, messages de pilotage pendant que l'agent travaille, et une revue guidée avec des commentaires de ligne renvoyés au fixer ; des diffs aux couleurs de git, colorés selon le langage pour chaque stack, mots modifiés surlignés et disposition côte à côte « Auto » ; cartes colorées par type avec aperçu au survol, ajout rapide, clic droit, sélection multiple avec actions en masse et Ctrl+Z, jauge de capacité par colonne, temps des agents, tokens et coût sur les cartes terminées, et une courte relecture par l'IA avant le départ.
- **Tableau agile** : colonnes Échec et Abandonnée, drapeau Bloquée, sprints avec points, couloirs, affichages Tableau / Liste / Frise, rapports (burndown, vélocité, flux cumulé, temps de cycle, débit, fins non abouties), étiquettes, filtres rapides et archivage auto, en local comme en mode serveur ; chaque changement de statut d'une carte est gardé dans son `status_history.json`.
- **Planification de sprint** avec jauge de capacité (vélocité, disponibilité), glisser-déposer, annulation, et **Proposer le sprint** : les règles et le modèle du provider choisi remplissent le sprint jusqu'à sa capacité en points, ce qu'une tâche attend d'abord, avec une raison par tâche et un but quand il n'y en a pas ; les règles seules sans modèle ([proposition de sprint](docs/architecture/sprint-proposal.md)).
- **Interroger le tableau** dans n'importe quelle langue : tous les tickets, éléments de feuille de route, idées et changements fusionnés liés, classés par le sens avec un modèle d'embeddings local d'abord, et la vérification d'une fonctionnalité prévue contre ce qui existe déjà, sur le bureau, un serveur d'équipe et le téléphone ([interroger le tableau](docs/architecture/board-ask.md)).
- **Où tournent les longues suites** : avant une revue QA complète, l'app décide sans modèle, d'après le CPU, la RAM, le GPU et la VRAM libres et la charge mesurée de la suite : ici, sur la CI de la forge depuis la branche de la tâche poussée sans PR (GitHub Actions, Azure Pipelines, GitLab CI, Bitbucket Pipelines, Jenkins), ou sur le serveur WorkPilot, jamais une suite sautée ; les tests touchés passent d'abord, une carte peut l'emporter sur le choix du projet, la fusion attend la CI, et après une fusion les autres cartes vertes reprennent la nouvelle base et repartent ([placement des tests](docs/architecture/test-placement.md), [reprise de la base](docs/architecture/suite-base-refresh.md)).
- **Niveaux d'approbation** N0 à N3 sur chaque pull request, lus sans modèle (type, couches, chemins sensibles, taille, CI, revue croisée) : N0 et N1 fusionnent seules une fois vertes, N2 et N3 attendent une personne ; en observation tant que le projet ne les applique pas, et la section `approvals` de `workpilot.policy.yaml` ne peut que les durcir. Les PR Dependabot et Renovate passent par une **voie express**, sans tâche ni modèle ([niveaux d'approbation](docs/architecture/approval-tiers.md), [voie express](docs/architecture/express-lane.md)).
- **Mode code** : un provider de la boucle WorkPilot peut écrire un seul `run_script` JavaScript dont chaque appel d'outil repasse par les mêmes contrôles, et une tâche ou un terminal Claude peut utiliser le REPL de Claude Code ; coupé par défaut, choisi par tâche ou par phase ([mode code](docs/architecture/code-mode.md)).
- Le **mode Essaim** construit côte à côte les sous-tâches que le plan permet, chacune dans son propre worktree, fusionnées dans la branche de la tâche après chaque vague.
- **Découpage automatique** des grosses tâches en petites PR groupées, **tâches empilées**, **Best-of-N** (construire une tâche 2 à 4 fois sur des moteurs différents et garder la meilleure, avec un arbitre quand les variantes ne font pas la même chose) et changements **multi-dépôts**, sur le provider, le modèle et l'effort choisis pour eux.
- L'**essai à blanc** rejoue le plan d'une spec sur la branche de base avant le build ; après la QA, un agent **red team** essaie de casser ce que la tâche a construit, et la **garde des migrations** dit ce que les migrations de la tâche feraient à une base en production, pour toutes les stacks.
- **Mode objectif** (terminé quand une commande le dit, par exemple `dotnet test` qui sort en 0), **revue croisée** par un second moteur, **spec par l'exemple** pour les Web API ASP.NET Core, **montées de version .NET** une version à la fois jusqu'à .NET 11.
- **Vérification à l'exécution** avec vidéos de preuve et comparaison avec la branche de base ; **portes strictes** contre les paquets inventés, les tests sans mordant et pour les preuves formelles ; [REA](docs/architecture/rea.md) lit le build laissé par une tâche, sans le lancer, et signale ce qu'il expose, et en .NET une API publique que la tâche a cassée.
- **Captures dans la pull request** : une tâche qui change un écran (toutes stacks : web, Razor, XAML, SwiftUI, Flutter, layouts Android, templates serveur, WinDev) prend ses écrans avant (branche de base) et après (la tâche), remplace chaque donnée personnelle par une fausse du même type et du même format (e-mail, téléphone, IBAN, carte, nom, adresse, secret) avant que l'image quitte la machine, et les montre dans une section « Captures » de sa pull request sur GitHub, GitLab, Azure DevOps et Bitbucket ; les images vont sur une branche à part jamais fusionnée (ou en pièces jointes Azure DevOps), gardées 30 jours après leur dernière mise à jour ; publiées seules, après la revue d'une personne, ou jamais. Sur un serveur d'équipe, le téléphone montre chaque écran avant et après et une personne qui relit les publie ou les retire ([captures](docs/architecture/pr-captures.md), [ce qui est traité, pour le registre RGPD](docs/pr-captures-data.md)).
- **Matrice d'appareils** dans l'émulateur : la page affichée, rendue sur plusieurs téléphones, tablettes, ordinateurs et un téléviseur à la fois (fenêtre, densité, user agent, tactile), côte à côte, au besoin sur un réseau bridé (4G, 3G rapide, 3G lente) et un processeur ralenti, avec les bugs responsive classiques signalés sur chacun : défilement de côté, médias trop larges, cibles tactiles de moins de 44 px, texte de moins de 12 px, éléments qui se chevauchent, texte coupé, navigation mobile inaccessible, chacun encadré sur la capture ; téléphones et tablettes aussi en paysage, au besoin avec les cookies de l'aperçu pour une page derrière une connexion, ouverte d'elle-même sur quatre appareils à la revue d'une carte dont les changements touchent l'interface ; la grille s'exporte en PNG ou en PDF ; vues vivantes des appareils cochés qui naviguent et défilent ensemble, appareils à vous, personas enregistrés (cookies chiffrés) et lecture de la page autour de chacun de ses points de rupture ([matrice d'appareils](docs/architecture/device-matrix.md)).
- **Enregistreur du Browser Agent** : pilotez une page à la main (survols, défilements, glisser-déposer et boîtes de dialogue répondues dans l'app compris) et obtenez un test Playwright (TypeScript ou Python), Cypress, Selenium (Python, Java, C#, Ruby ou JavaScript) ou WebdriverIO (JavaScript ou TypeScript) qui traverse iframes et shadow roots et attend ce que chaque action a provoqué, avec des sélecteurs robustes et les secrets lus dans des variables d'environnement, proposé sur une branche de revue. Lancez-le là, rejouez l'enregistrement pour reprendre les sélecteurs qui ont changé, et laissez le modèle rapide du provider nommer le test et classer les vérifications.
- Projets **WinDev, WebDev et WinDev Mobile** sauvegardés au format texte : les agents ne modifient que le code WLangage, une porte de la QA renvoie tout ce que seul l'éditeur peut écrire, et le WLangage est coloré dans la vue des diffs ([WinDev](docs/architecture/windev.md)).
- **Suivi des PR** : un check rouge ou un fil de revue sur la PR de la tâche repart vers le fixer, jamais forcé, jamais fusionné.
- **Provenance** : quelles lignes l'IA a écrites et avec quel modèle, un SBOM des paquets ajoutés, la traçabilité exigence-test.
- **Garde-fous en code** : une politique versionnée, par couches, que les agents ne contournent pas, appliquée aussi dans les worktrees des tâches ; chaque résultat d'outil est analysé contre l'injection de prompt avant que l'agent ne le lise.
- **Failles de sécurité classées par ce qui tourne** : le scan de sécurité de la QA range ses trouvailles en critiques et exposées, critiques mais dormantes, moyennes et informatives, d'après ce que vos points d'entrée atteignent (tout langage) et les incidents de production des 30 derniers jours dans `.workpilot/incidents/` (Sentry, Datadog, CloudWatch, New Relic…) ; le fixer voit d'abord les exposées, et ce qui bloque un build suit toujours la gravité.

**Agents et orchestration**
- **Vagues d'exécution** (Mission Control) : les specs en attente sont regroupées en vagues qui ne partagent aucun fichier, d'après leurs plans, leurs worktrees, les fichiers que l'historique git modifie ensemble, les imports croisés et les symboles supprimés, vérifiées par un merge de test, puis lancées vague après vague dans l'ordre de merge, avec le parallélisme du projet ; une exécution interrompue par un redémarrage peut être reprise, et les 14 derniers jours d'exécutions montrent les conflits évités ; aucun modèle n'est appelé.
- **Composition automatique** (Mission Control) : une équipe d'agents proposée d'après une description, la spec d'une tâche ou un modèle de session (bug, fonctionnalité, refonte, incident), sur les providers choisis et mélangés, modèles filtrés par leurs capacités, coûts du catalogue Cost Intelligence, équipe moins chère sous un budget ; pendant le travail, un agent bloqué passe à un autre provider ou à un modèle plus puissant, ou reçoit un agent d'appoint quand plus rien n'est à tenter, et les sessions passées calibrent les estimations ; un modèle Ollama local est jugé sur ce que le serveur dit qu'il sait faire.
- **Mission Control** pour lancer plusieurs agents sur un même objectif, **terminaux d'agents**, **Arène** et **Bounty Board** pour comparer les moteurs, **Repo bench** pour les mesurer sur vos propres tâches passées.
- **Pixel Office** montre vos agents en personnages pixel art à leur bureau, gagne des succès à partir de ce que le projet livre (tâches livrées, QA passée à la première revue, incidents résolus, accord d'un second moteur) sur tous les providers, vit des **saisons** de trois mois dont les objectifs d'équipe décorent le bureau, raconte une courte scène quand une tâche change de mains (écrite au choix par le modèle de la page, qui ne voit jamais le contenu de la tâche), habille chaque personnage aux couleurs de son fournisseur (ou d'un habit choisi, dont un gagné par les saisons), montre sur un projet du serveur le **classement de l'équipe** et les badges de chacun, calculés par le serveur de l'équipe, où personne n'est nommé sans l'avoir accepté, et propose un **mode TV** pour l'écran d'une équipe, avec un mode calme qui arrête les animations.
- **Rejeu d'agent** partage une session enregistrée : un fichier `.wpreplay` qu'un collègue importe, ou une page HTML que chacun ouvre sans WorkPilot, secrets et dossiers locaux masqués et, sur demande, sans le raisonnement, les tokens ou le contenu des fichiers ; des signets annotés marquent les étapes qui comptent. Dans un projet du serveur, un membre la partage avec l'équipe par un lien qui dure jusqu'à 30 jours, se révoque et compte ses ouvertures, et les lecteurs répondent à la note d'un signet. La page s'exporte aussi en vidéo WebM ou MP4 jouée étape par étape, seule ou côte à côte avec une autre session, et une session dont le modèle n'a laissé aucun raisonnement reçoit, à la demande, un court résumé de ses étapes par le modèle rapide du provider par défaut. La vue du rejeu montre, comptés sur la machine et envoyés nulle part, les exports de chaque semaine et la part des sessions annotées, et pour un projet du serveur les chiffres de ses liens calculés par ce serveur ; les Réglages listent chaque lien d'équipe qu'une personne a créé, sur tous ses projets, pour le révoquer.
- Agents spécialisés : générateur de tests, détective de tests instables (avec la cause et une carte de correction), refactoreur, docs et dérive, accessibilité (score WCAG 2.2 et corrections), i18n, veille des contrats d'API, preuves de conformité, notebooks (dépendances entre cellules, exécution en noyau neuf), migration, auto-guérison sur échec de CI, suivi de la dette technique ; leurs corrections vont sur une branche de revue, jamais directement dans votre dossier.
- **Une auto-guérison qui regarde plus loin que le dernier commit** : tendances de risque par fichier d'un scan à l'autre (liste des fichiers qui chauffent vite, dossiers qui se dégradent ensemble), erreurs de production de plusieurs outils de supervision groupées en un incident par bug avec ses commits suspects, et bisect d'un échec de CI dans un worktree temporaire qui nomme au correcteur le premier commit fautif.
- Le **Release Train** livre lui-même vos services, dans l'ordre des dépendances, avec contrôles de santé et smoke tests et un clic par service de production ; le **chirurgien de l'historique Git** nettoie les commits d'une branche sur une nouvelle branche, au code identique.
- **Pair programming avec une IA participante** : invitez WorkPilot IA dans une salle ; elle répond avec le provider choisi et propose du code en suggestion sur le fichier de la salle, sans jamais l'écrire ; sur un serveur d'équipe, `@ia` dans le chat d'équipe reçoit une réponse de l'IA.
- **Coach personnel** : il apprend votre style de code par langage à partir de votre historique git et de la config du lint, et donne vos préférences nettes au codeur et au correcteur QA.
- **Mémoire partagée** : un coffre Obsidian et un graphe que tous les agents lisent et écrivent, entre sessions et providers ; chaque décision sur la mémoire (créée, oubliée, restaurée, épinglée, fusionnée) est journalisée avec son auteur et sa raison et peut être reprise (la dernière décision automatique dans l'heure, une fusion à tout moment, deux patterns que le learning loop a fusionnés dans les 30 jours), une note oubliée reste 30 jours à la corbeille, et une synchronisation d'équipe qui contredit une note est signalée, une paire qui oscille allant aux mainteneurs que l'équipe désigne, et une mémoire peut être limitée à une partie du code ; la mémoire d'un projet du serveur a le même cycle de vie, décidé par qui peut écrire les insights du projet ([cycle de vie de la mémoire](docs/architecture/memory-lifecycle.md)) ; la boucle d'apprentissage analyse chaque build avec un modèle du provider choisi, et ses leçons atteignent la spec, le plan, le code et la QA ; des packs de **skills** indépendants du provider.
- **Leçons appliquées, par tâche** : le panneau de la tâche liste les règles adoptées, les motifs appris et les points de contrôle de son type (correctif, refactoring, montée de version…) que chaque prompt de la tâche a reçus, et chacun se désactive pour cette tâche seule ; les points de contrôle d'un type n'entrent dans sa spec que si l'historique QA du dépôt montre que les specs de ce type reviennent.

**Comprendre et planifier**
- **Insights**, **Idéation**, **Feuille de route**, visualiseur d'architecture avec la dérive d'architecture pour chaque grande stack (couches déduites des projets .NET, des modules Maven/Gradle et des paquets Go, Rust, PHP, Dart et Swift), règles de revue de code et code smells pour chaque grande stack, classificateur de risque.
- **Migration de code** de frameworks, de versions et de langages : le plan (phases, étapes, risque) s'affiche, puis une tâche Kanban l'applique.
- **Visuel vers Code**, **Import Design**, **générateur de pipelines** (GitHub Actions, GitLab CI, Azure Pipelines, Bitbucket, CircleCI) et un **assistant vocal** (Ctrl+Maj+Espace, une pédale sur F13–F24, ou un mot d'éveil optionnel) qui peut écouter en continu, répondre à voix haute avec les voix du système, suivre une tâche en cours et transmettre vos consignes parlées à son agent, et arrêter les agents en cours après leur étape quand on dit « stop ».

**Intégrations**
- GitHub, GitLab, Azure DevOps, Bitbucket Cloud, Jira et Linear : importer des tickets, les investiguer, relire des pull requests. Plusieurs comptes par forge, enregistrés une fois, chaque projet nommant le sien, et chaque projet lit le dépôt de ses propres remotes git ; le tri des issues GitHub les compare par le sens avec des embeddings Hugging Face ([comptes de forge](docs/architecture/forge-accounts.md), [Bitbucket](docs/architecture/bitbucket.md)).
- **Revue de PR par l'IA qui apprend** : accepter, rejeter ou marquer non applicable chaque résultat, avec une raison ; un type de remarque que le projet rejette sans cesse est rétrogradé, puis n'est plus remonté, sur tous les providers, revues de suivi comprises ; jamais un résultat de sécurité ou critique. Une vue par projet donne le taux d'acceptation par catégorie, réinitialise une règle apprise et écrit `.workpilot/review-conventions.md`. Sur un projet serveur, le rejet d'un membre attend le propriétaire du projet. Avant son verdict, une revue fond une remarque faite deux fois au même endroit ([retours de revue](docs/architecture/review-feedback.md)).
- Les **automatisations** transforment un événement (un ticket étiqueté, une CI rouge, une heure de la journée, un incident de production venu de Sentry) en carte brouillon ; les **déclencheurs CI/CD** lancent votre pipeline (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) quand un agent ouvre la PR d'une tâche ou quand elle est fusionnée, puis **surveillent le déploiement** (health check et métriques Prometheus comparés à leur niveau d'avant) et proposent, ou lancent, un **rollback** vers la dernière exécution réussie ; un mauvais verdict donne un **rapport d'incident** (les chiffres, puis quelques phrases de votre modèle), une notification et, sur demande, une **PR de revert** du commit déployé sur votre forge.
- Marketplace MCP et serveurs MCP personnalisés avec descriptions d'outils épinglées ; chaque serveur du catalogue affiche un **score de sécurité** sur 100 (éditeur, permissions des outils, version épinglée, date de version, vulnérabilités connues via OSV, changement de mainteneurs, analyse statique du code lancé), les serveurs installés sont revérifiés chaque jour avec des alertes à acquitter, et un projet peut restreindre ce qui s'installe (`.workpilot/mcp-policy.json`) et faire tourner un serveur à score faible **confiné** dans le bac à sable de l'OS, avec seulement les hôtes qu'il liste sur le réseau, quel que soit le provider ; sur un projet du serveur, l'équipe laisse ses avis sur chaque serveur du catalogue ; le serveur MCP **workpilot-board** donne votre Kanban à Claude Code, Codex, Gemini CLI, Copilot, Cursor et d'autres.
- Notifications sur Slack, Teams, Discord, Google Chat, webhooks, ntfy et Telegram.

**Équipe**
- **Mode serveur** : un serveur pour l'équipe, toutes les features partagées en direct, organisations isolées, rôles, groupes et administrateurs, connexion JWT, Microsoft Entra ou tout fournisseur OpenID Connect (Okta, Google, Keycloak…), mot de passe oublié réinitialisé depuis l'écran de connexion (par e-mail, ou par un lien qu'un administrateur émet), spec approuvée par une autre personne que l'auteur de la carte, par autant d'approbateurs que sa criticité en demande, approbations prêtées pendant une absence, un second groupe d'approbateurs prévenu quand un plan attend trop, et chaque action du journal rattachée à la connexion sous laquelle elle a été faite, connexions refusées et jobs lancés compris ; la consommation et les jours d'activité de chacun gardés une durée réglable, puis effacés, et l'activité par page (désactivée tant qu'une organisation ne l'active pas) ([ce qui est gardé, pour le registre RGPD](docs/server-usage-data.md)) ; hébergé là où chaque équipe le peut (un VPS en HTTPS, une machine du réseau local ou un seul ordinateur, au choix de `deploy/configure.py`), avec des quotas par organisation dont un budget mensuel de tokens, une page de santé pour l'opérateur, des métriques Prometheus et des spans OpenTelemetry des requêtes (sans personne dans les uns ni les autres) ([guide de mise en place et d'usage](docs/server-guide.md), [guide d'exploitation](docs/server-operations.md)).
- **App mobile** pour iOS et Android : onglets par projet, une boîte « Pour vous » sur tous les projets, recherche, filtres et actions rapides sur le tableau, une mise en page tablette, chat d'équipe, interroger le tableau, les captures d'une carte avant et après, votre compte IA par défaut et votre utilisation, la vue d'ensemble de l'organisation pour les administrateurs, inscription sur invitation uniquement.

**Coûts et suivi**
- Budgets de coût appliqués pendant l'exécution : un budget du projet par période et un plafond par tâche, vérifiés avant chaque session d'agent sur tous les fournisseurs ; la tâche se met en pause à son plafond, peut passer à un modèle plus léger du même fournisseur, et une tâche qui dépense sans avancer est mise en pause elle aussi.
- Coupe-circuit et arrêt d'urgence : un agent qui répète le même appel d'outil avec le même résultat est mis en pause sur tous les fournisseurs, et « Arrêter tous les agents » (bouton de la barre latérale, Ctrl+Maj+.) met en pause chaque tâche en cours, à reprendre depuis sa carte.
- Gouvernance dans `workpilot.policy.yaml` : heures permises dans un fuseau explicite, fichiers interdits ou soumis à revue, budgets de jetons par heure et par tâche, limite du coupe-circuit, appliqués à chaque agent sur tous les fournisseurs et entre les vagues du Swarm ; un fichier invalide met chaque tâche en pause, et chaque décision (coupe-circuit compris) entre dans un journal d'audit, compté par jour et par semaine, exportable en CSV ou JSON depuis Réglages > Garde-fous. Sur un serveur d'équipe, la même page (et l'app mobile) y lit la politique du projet, approuve un appel en attente au nom de votre compte et de ses rôles (`files.reviewers` peut en exiger un), et « Arrêter tous les agents » arrête aussi les runs que vous y avez lancés.
- Smart Estimation qui apprend chaque dépôt : l'estimation d'une tâche est corrigée par ce qu'ont réellement consommé ses specs fusionnées (coût, tokens, itérations de QA, fichiers modifiés), affichée en fourchette avec sa confiance et un détail par dimension, avec votre propre ajustement et une remise à zéro ; tous les providers alimentent le même historique.
- Tableau de bord analytique avec « Où vous en êtes » (un projet comparé à son passé et à vos autres projets de même pile, de même taille et de même équipe, par spec et par type de travail, score de mutation et CI verte du premier coup compris, avec les 10 % les meilleurs, votre rythme face à la médiane, une courbe par semaine et un rapport d'équipe en PDF, sans rien envoyer), estimateur de coûts, Formula Lab (estimation du coût et de la réussite par provider, modèle et effort), moniteur de limites de débit avec bascule de compte, profileur carbone avec un budget mensuel et un export ESG, traces OpenTelemetry GenAI pour chaque provider.
- Sur un serveur d'équipe, un rapport d'usage quotidien par e-mail, à 9 h par défaut (heure à la minute, n'importe quel fuseau, les jours et jusqu'à 20 adresses que chaque organisation choisit, en français ou en anglais, avec ou sans noms, rapports hebdomadaire et mensuel en plus) : chaque chiffre face à la veille et à la moyenne des 7 jours, les plus gros consommateurs, fournisseurs et modèles, les causes des échecs et les alertes de budget à 80 % et 100 % (celui de l'organisation, et des budgets mensuels par personne, groupe ou projet qui peuvent bloquer leurs runs) ; envoyé une seule fois, même après un redémarrage, et lisible dans l'app sans SMTP ([ce qu'il contient](docs/server-usage-data.md#le-rapport-par-e-mail)).

**Apparence**
- Une seule charte graphique dans tous les modules, qui suit le thème actif : 7 thèmes de couleur en clair et en sombre plus un éditeur de thème, interface complète en anglais et en français ; les dates, les heures et les calendriers suivent la langue de l'app (28/11/2026 et 14:30 en français, 11/28/2026 et 02:30 PM en anglais), et non la région du système.
- Un menu léger : un rail d'espaces avec un seul panneau à la fois, arrangé par chacun (glisser une page sur un autre espace, réordonner les épingles, ou « Personnaliser le menu » au clavier) et redimensionnable à la souris, « Mon menu » pour les pages épinglées et récentes, quatre hubs dans la Boîte à outils, les pages bêta dans un **Labo**, une proposition de masquer les pages inutilisées depuis 30 jours, les outils CLI dans une pastille ; la palette de commandes (Ctrl+K ou `/`) trouve chaque page par son nom, son groupe ou un mot-clé.
- Un assistant de premier lancement qui configure n'importe quel provider d'IA et dit honnêtement lesquels sont connectés.

---

## Providers d'IA

| Provider | Connexion |
|----------|-----------|
| **Anthropic Claude** | Connexion Claude Code (abonnement), ou un profil d'API : une URL de base et son jeton |
| **OpenAI** | Clé d'API, ou la CLI Codex connectée |
| **Google Gemini** | Clé d'API, ou Gemini CLI via l'Agent Client Protocol |
| **Grok (xAI)**, **Mistral**, **DeepSeek** | Clé d'API |
| **GitHub Copilot** | Connexion GitHub (abonnement Copilot) |
| **Windsurf** | Clé d'API, ou la clé de l'IDE Windsurf installé |
| **OpenRouter**, **Hugging Face** | Clé d'API : des centaines de modèles derrière une seule passerelle, la liste en direct limitée aux modèles qui appellent des outils, prix et fenêtre lus chez la passerelle ([passerelles](docs/architecture/gateway-providers.md)) |
| **Modèles locaux** | Ollama, LM Studio ou llama.cpp, sans clé |
| **Agents CLI** | Codex, OpenCode, Antigravity, pi, Hermes : installés et mis à jour en un clic depuis la barre latérale **Outils CLI** |

Plusieurs comptes peuvent être enregistrés par provider : plusieurs clés pour chaque provider à clé d'API (OpenAI, Google, Mistral, DeepSeek, Grok, Meta, OpenRouter, Hugging Face, Cursor, Windsurf ; AWS sous forme de paire de clés et de région), les profils de connexion de Claude, et une connexion par compte pour Copilot, Codex CLI et Gemini CLI. Chaque provider a un compte par défaut, changé depuis sa popin ; chaque compte montre sa dépense face à un budget mensuel facultatif, et un projet ou une seule carte Kanban peut épingler son propre compte. Sur un serveur d'équipe, chaque membre garde ses propres comptes ([comptes IA](docs/architecture/ai-accounts.md)). Avec le basculement automatique, une tâche arrêtée par une limite de débit, un quota épuisé, une clé refusée ou une connexion perdue reprend d'abord sur les autres comptes de son provider, puis sur l'entrée suivante de la chaîne que vous ordonnez (comptes Claude, profils API, Copilot, OpenAI, Mistral, Ollama…), à la phase où elle s'est arrêtée. La répartition de l'utilisation nomme le forfait de chaque compte tel que le fournisseur l'indique (Claude Pro ou Max, ChatGPT Plus ou Pro, Copilot…) ou dit qu'il est facturé par clé API. Les clés sont stockées dans le trousseau du système et affichées masquées ; l'interface ne reçoit jamais leur valeur. Meta, AWS et Cursor peuvent être configurés mais n'ont pas encore de client d'agent : leurs builds tournent sur Claude, et la tâche le signale. Variables et valeurs par défaut : [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (en anglais).

---

## Architecture

Comment les pièces communiquent :

<a href=".github/assets/showcase/architecture.fr-light.png">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/showcase/architecture.fr-dark.png">
  <img alt="Architecture : sur votre machine, l'application de bureau et le moteur Python travaillent sur votre dépôt git, un worktree par tâche ; le moteur parle aux fournisseurs d'IA, aux forges et outils de suivi et aux autres clients IA ; un serveur d'équipe optionnel partage le tableau avec l'application mobile" src=".github/assets/showcase/architecture.fr-light.png" width="100%">
</picture>
</a>

Où elles vivent dans le dépôt :

| Dossier | Contenu |
|---|---|
| `apps/backend/` | Agents Python, specs, QA, API locale, mode serveur |
| `apps/frontend/` | App de bureau Electron (React + TypeScript) |
| `apps/mobile/` | App iOS et Android (Expo), cliente du mode serveur |
| `src/` | Connecteurs Python partagés (Jira, Azure DevOps…) |
| `capabilities/` | Ce que sait faire chaque provider et harness |
| `config/` | Liste des providers affichée dans les Paramètres |
| `workflows/` | Un workflow déclaratif par type de tâche |
| `skills/` | Packs de skills (`.agents/skills/` est généré) |
| `deploy/` | Image serveur et docker-compose |
| `changelog.d/` | Un fragment de changelog par pull request |
| `docs/` | Règles, justifications de conception, guides |
| `tests/` | Tests Python (les tests frontend sont à côté du code) |
| `scripts/` | Scripts de build, de release et de maintenance |

Comment les pièces s'assemblent (agents, sous-agents, workflows, état, couches de sécurité) : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Pourquoi chaque feature est construite ainsi : [docs/architecture/](docs/architecture/). Un atlas guidé et cliquable, lisible sans bagage technique : [docs/audit/WorkPilot-architecture.html](docs/audit/WorkPilot-architecture.html). Les instructions pour les agents de code commencent à [`AGENTS.md`](AGENTS.md).

### Ligne de commande

```bash
cd apps/backend
python runners/spec_runner.py --interactive   # Créer une spec en mode interactif
python run.py --spec 001                      # Lancer le build autonome
python run.py --spec 001 --review             # Relire
python run.py --spec 001 --merge              # Fusionner
```

Référence complète : [docs/CLI-USAGE.md](docs/CLI-USAGE.md) (en anglais).

---

## Sécurité

1. **Bac à sable du système** : les commandes des agents tournent sous bubblewrap (Linux) ou Seatbelt (macOS), et la carte indique quand une tâche tourne sans bac à sable. En option, coupée par défaut (Paramètres > Sandbox) : une **microVM Docker Sandboxes par tâche**, avec son noyau et son moteur Docker, seul le worktree monté, le réseau fermé hors de l'allowlist de la tâche, une commande arrêtée au délai arrêtée aussi dans la VM, et sbx lancé sans les identifiants de l'hôte ; c'est aussi ce qui isole les commandes sous Windows 11.
2. **Restrictions du système de fichiers** : les opérations restent dans le dossier du projet.
3. **Liste blanche dynamique de commandes** : seules les commandes de la stack détectée sont autorisées.
4. **Instantanés et score de confiance** : avant chaque session d'agent, le worktree de la tâche est enregistré comme un commit git caché ; chaque session démarre avec un score de confiance de 100 que les anomalies font baisser, et sous un seuil la tâche se met en pause, ou la session s'arrête et son instantané est restauré. Le mode restreint et les limites par session sont dans Paramètres > Sandbox ; un instantané se restaure depuis la carte.

Les clés d'API et les jetons sont chiffrés au repos avec le trousseau du système (sous WSL sans trousseau, avec le DPAPI de Windows) ; Paramètres > Comptes indique depuis quand chaque clé d'API a été enregistrée et suggère de la renouveler après 90 jours. Chaque version fournit les sommes de contrôle SHA256, un SBOM CycloneDX et une attestation de provenance de build par fichier.

Pour signaler une vulnérabilité, suivez [docs/SECURITY.md](docs/SECURITY.md), jamais un ticket public. Les règles que suivent les contributeurs et les agents de code sont dans [docs/rules/security.md](docs/rules/security.md).

---

## Documentation

| Document | Contenu |
|----------|---------|
| [Features](docs/FEATURES.md) | Chaque feature, par domaine (en anglais) |
| [Installation](docs/INSTALLATION.md) | Prérequis, méthodes d'installation, configuration des providers, notes Windows, dépannage |
| [Configuration](docs/CONFIGURATION.md) | Registre des providers, résolution des identifiants, variables d'environnement (en anglais) |
| [Utilisation en CLI](docs/CLI-USAGE.md) | Usage sans interface et en CI (en anglais) |
| [Architecture](docs/ARCHITECTURE.md) | Agents, workflows, état et couches de sécurité |
| [Justifications de conception](docs/architecture/) | Pourquoi chaque feature est construite ainsi, un fichier par feature |
| [Guide du serveur d'équipe](docs/server-guide.md) | Paramétrer, configurer et utiliser le serveur d'équipe, avec exemples et formats : `.env.server`, rôles, projets, quotas, app, téléphone, MCP, API |
| [Exploitation du serveur](docs/server-operations.md) | Faire tourner le serveur d'équipe : déploiement, TLS, sauvegardes, mises à jour, quotas |
| [Linux](docs/linux.md) · [Développement sous Windows](docs/windows-development.md) | Notes par plateforme (en anglais) |
| [Contribuer](docs/CONTRIBUTING.md) | Environnement de développement, style de code, tests, pull requests (en anglais) |
| [Processus de release](docs/RELEASE.md) | Comment les versions sont préparées et publiées (en anglais) |
| [Politique de sécurité](docs/SECURITY.md) | Versions supportées, signaler une vulnérabilité (en anglais) |
| [Plan de la documentation](docs/README.md) | Où vit chaque document et à quoi il sert |
| [Wiki](https://github.com/krovomi/WorkPilot-AI/wiki) | Guides utilisateur, rafraîchis après chaque version |

---

## Contribuer et communauté

Les contributions sont les bienvenues : commencez par [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Les pull requests ciblent `develop`. Les nouvelles versions sortent toutes seules, au plus une fois par jour : le pilote de release déduit majeure, mineure ou patch des pull requests fusionnées, écrit la documentation de la version et fusionne `develop` dans `main` ([processus de release](docs/RELEASE.md#automatic-releases-release-autopilot)).

- **Tickets** : [signaler un bug ou demander une feature](https://github.com/krovomi/WorkPilot-AI/issues)
- **Discussions** : [poser une question](https://github.com/krovomi/WorkPilot-AI/discussions)

---

## Licence

**AGPL-3.0**, GNU Affero General Public License v3.0. WorkPilot AI est libre d'utilisation. Si vous le modifiez et le distribuez, ou le faites tourner comme service, votre code doit aussi être open source sous AGPL-3.0. Une licence commerciale est disponible pour les usages en source fermée.

[![GitHub Repo stars](https://img.shields.io/github/stars/krovomi/WorkPilot-AI?style=social)](https://github.com/krovomi/WorkPilot-AI/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=krovomi/WorkPilot-AI&type=Date)](https://star-history.com/#krovomi/WorkPilot-AI&Date)
