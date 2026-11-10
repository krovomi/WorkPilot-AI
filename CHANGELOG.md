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
