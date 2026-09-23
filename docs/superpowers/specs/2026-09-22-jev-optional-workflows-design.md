# JEV optionnel dans les workflows WorkPilot-AI

Date : 2026-09-22. Statut : spécification approuvée par l'utilisateur ; plan d'implémentation rédigé séparément pour relecture.

## Objectif et contrat de compatibilité

Intégrer JEV de TypeSafe comme service de décisions structurées utilisable dans les workflows, avec activation explicite et bypass. WorkPilot doit démarrer, planifier, coder et valider sans compte TypeSafe, sans clé et sans accès à son API. Installer la mise à jour ne doit activer aucun appel JEV.

Le périmètre approuvé couvre une activation globale, un choix par workflow, une classification avant planification, des évaluations complémentaires lors des revues, le stockage sécurisé de la clé, le respect du mode hors ligne et le retour au comportement existant en cas d'indisponibilité. Le mot « workflow » désigne ici un parcours d'exécution identifié ; une phase est une étape de ce parcours.

JEV ne remplace ni le modèle de génération de code, ni les tests, ni le reviewer, ni une approbation humaine. Une évaluation positive ne marque jamais un build, une QA ou une revue comme accepté. Une évaluation négative est une information pour la revue habituelle, pas une nouvelle porte bloquante.

## Ce qui existe et points d'appui

| Élément vérifié | Rôle dans l'intégration |
| --- | --- |
| `workflows/feature-build/workflow.yaml` | Déclaration du pipeline de build livré avec le dépôt. |
| `apps/backend/workflows/spec.py` | Contrat des workflows et phases ; toute extension reste facultative. |
| `apps/backend/workflows/engine.py` | Résolution des phases selon effort, provider et fichiers ; préservation des hard gates. |
| `apps/backend/workflows/runner.py` | Exécution des phases dans les fenêtres du pipeline. |
| `apps/backend/cli/build_commands.py` | Orchestration réelle du build et parcours historique lorsque le moteur est désactivé. |
| `apps/backend/workflows/api.py` | Profil prévisionnel destiné à l'interface ; lecture sans effet de bord. |
| `apps/backend/model_router/router.py` | Classification locale `classify_task`, classes `TaskClass` et sélection de modèles. |
| `apps/backend/core/offline_policy.py` | Politique commune d'interdiction des services distants. |
| `apps/frontend/src/renderer/components/task-detail/WorkflowProfileCard.tsx` | Présentation du profil d'exécution d'une tâche. |
| `apps/frontend/src/shared/types/settings.ts`, `src/main/ipc-handlers/settings-handlers.ts` | Réglages typés et persistance desktop, chemins relatifs à `apps/frontend`. |
| `apps/frontend/src/main/api-explorer-secret-store.ts` | Exemple existant de chiffrement via l'OS ; les secrets JEV auront leur propre domaine. |

Le fichier YAML livré est actuellement `feature-build`. La première livraison raccorde aussi les parcours de revue ci-dessous. L'UI n'annonce jamais une intégration sur une surface sans appelant effectif. La classification locale existante reste pure et sans réseau : ajouter un appel HTTP directement dans `classify_task` ferait aussi payer les aperçus et les appelants synchrones.

| Identifiant de réglage | Point d'exécution à raccorder | Usage |
| --- | --- | --- |
| `feature-build` | `apps/backend/cli/build_commands.py` et frontières de revue du build | Classification avant planning ; évaluation complémentaire avant revue/QA. |
| `github-review` | `apps/backend/runners/github/services/pr_review_engine.py`, y compris les chemins parallèles et de suivi qu'il délègue | Évaluation complémentaire du changement effectivement relu. |
| `gitlab-review` | `apps/backend/runners/gitlab/services/mr_review_engine.py` | Même évaluation complémentaire pour une MR. |
| `azure-devops-review` | `apps/backend/runners/azure_devops/services/pr_review_engine.py` | Même évaluation complémentaire pour une PR Azure DevOps. |

Les workflows déclaratifs additionnels réutilisent les frontières communes du moteur sous leur propre nom. Roadmap, Ideation et les autres outils restent fonctionnels sans ajout d'appels JEV dans cette livraison : leur attribuer un réglage sans usage effectif serait trompeur.

## Choix d'architecture

Un service Python partagé, `apps/backend/integrations/jev/`, possède les réglages, les schémas, le transport TypeSafe et les décisions de bypass. Les points d'entrée des workflows l'appellent avec un contexte explicite, et ne réimplémentent pas l'authentification ou le repli.

L'adaptateur appelle l'API HTTP documentée au moyen d'une dépendance HTTP déjà présente. Aucun SDK TypeSafe obligatoire, téléchargement au démarrage, plugin externe ou inscription n'est requis. Les clients de génération existants continuent à être construits par les fabriques habituelles ; JEV n'est pas ajouté à leur liste de providers conversationnels.

Deux alternatives sont écartées : un simple skill TypeSafe aiderait les agents à programmer avec JEV sans intégrer les workflows ; remplacer les décisions et validations existantes par JEV imposerait une dépendance au service et ne satisferait pas le fonctionnement sans clé.

## Configuration et précédence

Les nouveaux champs non sensibles sont optionnels dans les anciens fichiers de réglages et prennent les valeurs suivantes quand ils sont absents :

- `enabled: false` : valeur globale utilisée par les workflows qui héritent.
- `workflows: {}` : dictionnaire d'identifiants de workflow vers `inherit`, `enabled` ou `bypass`.
- `model: "jev-latest"` : alias initial, séparé du modèle du coder.
- `minimumConfidence: 0.8` : seuil WorkPilot pour accepter Choice et Score, configurable et compris entre 0 et 1.
- `timeoutSeconds: 5` : budget total maximal d'une évaluation ; zéro relance automatique.

Le seuil de 0,8 et le délai de cinq secondes sont des choix produit, pas des garanties TypeSafe. Le réglage par workflow est plus spécifique que la valeur globale : `enabled` permet d'activer seulement un parcours, `bypass` permet d'en exclure un, et `inherit` suit la valeur globale. Le libellé de l'UI doit donc préciser que la valeur globale est une valeur par défaut.

Ordre de résolution : politique hors ligne → mode du workflow → présence d'une clé utilisable → validité et taille du contexte → appel → validation de la réponse → seuil de confiance. Aucune activation ne contourne le mode hors ligne. Un ancien réglage, une configuration JEV illisible ou une valeur JEV invalide provoque un bypass de cette intégration, sans masquer une erreur indépendante du workflow.

Desktop : les réglages passent par IPC et sont persistés avant d'être présentés comme actifs. CLI : `TYPESAFE_API_KEY` fournit la clé en mémoire ; `WORKPILOT_JEV_ENABLED` définit le défaut et `WORKPILOT_JEV_WORKFLOW_MODES` fournit le dictionnaire JSON des exceptions. Les champs absents gardent leurs valeurs par défaut. Une clé seule n'active pas JEV.

Les changements de réglage s'appliquent au prochain lancement du workflow. Chaque exécution prend un instantané non sensible de sa configuration ; la politique hors ligne est revérifiée avant chaque requête. Une clé modifiée doit être résolue au prochain lancement, sans état « configuré » provenant seulement d'un ancien libellé.

## Clé et frontières de processus

Dans Electron, le main process possède la clé persistée, chiffrée par le stockage sécurisé de l'OS. Le renderer ne conserve qu'un état `configured` et un champ de saisie temporaire pour remplacer la clé. La suppression est explicite et distincte d'un champ vide laissé inchangé. La clé n'apparaît ni dans les settings JSON ordinaires, ni dans Zustand persisté, ni dans localStorage, ni dans les métadonnées d'une tâche.

Si aucun chiffrement système réel n'est disponible, la sauvegarde sécurisée est refusée avec un message traduit et les workflows continuent sans JEV. Un backend de stockage Linux en texte brut ne compte pas comme chiffrement système.

La transmission au processus backend chargé de l'exécution utilise son environnement privé au lancement, jamais un argument de commande ou un fichier temporaire en clair. Le constructeur d'environnement commun doit couvrir les appelants branchés ; la clé ne doit pas être copiée vers des terminaux ou outils sans usage JEV. Aucun aperçu de workflow ne lance une requête de test ni ne consomme un marqueur de reprise du provider.

Les routes desktop restent dans les frontières de sécurité actuelles. Cette livraison n'ajoute pas de route serveur acceptant des chemins arbitraires ou une clé globale partagée entre tenants. Un parcours serveur sans contexte de secret autorisé pour son tenant est bypassé avec un motif explicite.

## Contrat du service

Entrée : identifiant de workflow, point d'évaluation, identifiant d'exécution, contexte projet/spec pour la politique hors ligne, état sélectionné et questions prédéfinies par WorkPilot. La clé ne fait pas partie des objets sérialisables du contexte.

Sortie interne : statut `evaluated` ou `bypassed`, motif stable si bypass, réponses validées si évaluation, modèle réellement renvoyé, confiance disponible et usage renvoyé par l'API. Les appelants choisissent un résultat JEV utilisable ou leur traitement existant ; aucun code HTTP ou exception brute ne devient un verdict métier.

Motifs de bypass : `disabled`, `workflow_bypass`, `offline`, `missing_key`, `invalid_config`, `missing_context`, `context_too_large`, `unauthorized`, `rate_limited`, `timeout`, `unavailable`, `invalid_response`, `low_confidence` et `unsupported_context`.

Le transport cible uniquement `https://api.typesafe.ai/v1/systemone`, sans suivi de redirection, avec authentification Bearer. La requête contient `state`, `model` et `questions`. Les sorties Choice, Score et Noul sont validées selon leur type ; les nombres doivent être finis et dans les bornes attendues, et les choix appartenir aux options envoyées. Une question manquante ou un type différent rend cette évaluation inexploitable.

Choice et Score disposent d'une confiance ; Noul est une probabilité et ne possède pas ce même champ. La première livraison utilise Choice pour la classification et Score pour les revues. Elle ne fabrique pas de confiance Noul. Les données ne sont jamais utilisées comme des instructions système, commandes ou expressions exécutables.

Budget réseau : un appel par point d'évaluation et par passage du workflow, regroupant les questions indépendantes ; réponse limitée à 256 Kio. Au-delà du délai total ou en cas de 401/403/429/5xx, on continue sans JEV. Pour éviter de répéter un échec à chaque sous-tâche, une erreur d'authentification, de quota ou de disponibilité suspend les appels JEV restants pour cette exécution. Un nouveau lancement réessaie selon la configuration courante.

Une annulation, pause coopérative ou interruption du build conserve son sens : elle ne devient pas un bypass qui autoriserait le workflow à continuer.

## Usages effectifs dans les workflows

### Classification avant planification

L'orchestrateur demande une classification sur les classes déjà définies dans `TaskClass`. Une réponse valide et suffisamment confiante est fournie au routage existant lorsque celui-ci est activé. Sinon, il utilise exactement son classificateur local. La sélection explicite de provider, modèle ou effort par l'utilisateur reste prioritaire.

Sans routage automatique, la classification peut être présentée au planner comme information complémentaire, sans modifier les choix utilisateur. L'appel appartient à la frontière d'exécution, pas au rendu d'un aperçu ou à chaque message du coder.

Le build déclaratif et son parcours historique doivent partager ce point d'évaluation : désactiver `WORKPILOT_WORKFLOW_ENGINE` ne doit ni casser le build, ni laisser un réglage JEV qui paraît actif mais n'est jamais appliqué. Chaque autre parcours raccordé fournit un identifiant stable et utilise le même service ; il bénéficie donc du même réglage de bypass et des mêmes conditions de repli.

### Évaluations complémentaires de revue

Avant une revue/QA, le service évalue deux dimensions séparées : couverture apparente des critères d'acceptation et risque apparent du changement. Chaque Score utilise une rubrique écrite et versionnée avec le code. Le résultat et les limites du contexte sont ajoutés au contexte du reviewer existant.

Un score ne remplace jamais les observations du reviewer ni les résultats des tests. En cas de bypass, le reviewer reçoit son contexte habituel sans valeur JEV inventée. Aucun changement de `hard_gate`, de la présence de QA, du statut d'approbation ou des conditions de merge ne dépend de ces scores.

### Contexte transmis

Le contexte est construit à partir de la demande et des critères d'acceptation pour la classification ; pour la revue, il ajoute un résumé des fichiers modifiés, des résultats de validation et des extraits de diff ciblés. Il n'exporte pas tout le dépôt, les fichiers d'environnement, le magasin de secrets ou les journaux d'authentification. Les valeurs sensibles connues sont retirées avant sérialisation.

La taille UTF-8 maximale du contexte sérialisé est fixée à 64 Kio. Si les éléments utiles ne tiennent pas dans cette limite, l'intégration est bypassée avec `context_too_large` plutôt que de tronquer silencieusement une preuve. L'activation explique que les extraits sélectionnés sont envoyés à TypeSafe.

## Interface et observabilité

Une section JEV dans les réglages expose la valeur globale par défaut, l'état de la clé, son remplacement/suppression et les choix par workflow pris en charge. Les textes visibles passent par les ressources réellement chargées dans `apps/frontend/src/shared/i18n/locales/{en,fr}/`.

Le profil d'une tâche distingue le mode configuré, l'éligibilité prévue et le résultat réellement observé. Avant exécution, « prêt » signifie seulement que les prérequis locaux sont satisfaits, pas que l'API a validé la clé. Après exécution, il affiche « évalué » ou « bypassé » avec son motif et, si applicable, les scores/confiances.

Les états indisponible, sans clé et hors ligne ne désactivent pas le bouton de lancement et ne déclenchent pas une demande de connexion obligatoire. Une modification de réglage ou de projet invalide le bon état affiché sans réutiliser les scores d'une autre tâche.

Les traces structurées conservent le point d'évaluation, le statut, le motif, le modèle et l'usage, mais jamais la clé, l'en-tête Authorization, le corps brut de requête ou une exception distante non filtrée. Le rechargement de la tâche doit préserver le motif du dernier passage, sans utiliser un ancien résultat pour approuver une nouvelle révision.

## Critères d'acceptation et vérification

1. Mise à jour avec d'anciens réglages : application et workflows démarrent ; zéro appel TypeSafe et aucune nouvelle dépendance de compte.
2. JEV désactivé ou workflow bypassé : résultat de classification local et parcours de revue identiques au comportement précédent, zéro réseau JEV.
3. Activation d'un seul workflow lorsque le défaut global est désactivé : seul ce workflow appelle JEV. Un autre workflow en bypass reste exclu si le défaut global est activé.
4. Clé absente, vide, supprimée ou indéchiffrable : lancement possible, motif visible et aucun appel HTTP.
5. Réponse Choice/Score valide : résultat consommé à la frontière prévue et visible ; les choix explicites de modèle et les validations obligatoires restent respectés.
6. Confiance faible, JSON invalide, type inattendu, option inconnue ou nombre hors limites : repli local, aucune décision fondée sur la réponse invalide.
7. Erreur d'authentification, quota, réseau, serveur ou délai : repli borné, pas de boucle de retries, état explicite.
8. Mode hors ligne : zéro requête ni téléchargement JEV, même avec clé et activation explicite ; revérification si la politique change entre deux phases.
9. Pause et annulation pendant un appel : le workflow s'arrête ou se met en pause selon les mécanismes actuels.
10. Profil prévisionnel : zéro appel JEV, aucune consommation d'un marqueur de reprise et absence de fausse validation de clé.
11. Desktop : clé chiffrée, pas de fuite dans persistance/logs/arguments, suppression effective et prise en compte d'une nouvelle clé au lancement suivant.
12. Chaîne réelle Electron → backend → classification → revue vérifiée avec transport simulé, moteur déclaratif activé puis désactivé ; un test du seul adaptateur ne suffit pas. Les trois moteurs de revue GitHub, GitLab et Azure DevOps doivent également avoir un test au niveau de leur appelant réel, comprenant leurs chemins de suivi pertinents, sans publier de commentaire externe pendant les tests.
13. Régressions du moteur, de ses hard gates et du profil API : tests existants conservés ; matrice de modes couvrant au moins deux identifiants de workflow.
14. UI : états et interactions FR/EN, conservation des réglages, absence de blocage sans compte, isolation entre projets/tâches et réinitialisation du champ secret après sauvegarde.

Les tests backend seront placés sous `tests/` et utiliseront un faux transport, sans clé réelle ni coût API. Ils compléteront `test_workflow_engine.py`, `test_workflow_runner.py`, `test_workflow_profile_api.py` et `test_workflow_hard_gates.py`. Les tests frontend couvriront IPC, stockage sécurisé, passage de configuration et composants. Les contrôles emploieront Ruff 0.15.7 et Biome 2.4.10, puis les vérifications TypeScript pertinentes.

Un essai réel de l'API reste facultatif et distinct des validations locales ; sans clé disponible, le compte rendu ne prétendra pas avoir vérifié le service distant. La documentation utilisateur décrira activation, bypass, priorité des réglages, contenu transmis et dépannage sans imposer TypeSafe.

## Sources

- [Rôle de JEV avec les agents de code](https://docs.typesafe.ai/introduction/coding-agents).
- [Démarrage et authentification](https://docs.typesafe.ai/introduction/quickstart).
- [Contrat HTTP et types de réponse](https://docs.typesafe.ai/api).

Les seuils, budgets, états internes et règles de repli ci-dessus sont des décisions WorkPilot. Ils ne sont pas présentés comme des capacités ou engagements de TypeSafe.
