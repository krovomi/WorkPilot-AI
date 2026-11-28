# Captures des tâches dans les PR : ce qui est traité et combien de temps

Cette page décrit, pour le registre des traitements de chaque équipe (RGPD, article 30), ce que
font les captures qu'une tâche prend de son app et montre dans sa PR
([conception](architecture/pr-captures.md)). Elle suit le code : un changement de ce qui est pris,
gardé ou publié la met à jour dans la même PR. Elle vaut pour l'app de bureau et pour le serveur
d'équipe ; ce que le serveur garde sur l'usage de ses membres est [une autre page](server-usage-data.md).

## Le traitement

| | |
|---|---|
| **Finalité** | montrer à la revue d'une PR ce que la tâche a changé à l'écran : l'« avant » (branche de base) et l'« après » (la tâche) de chaque écran touché |
| **Responsable** | l'équipe qui utilise WorkPilot sur son dépôt (WorkPilot n'en reçoit rien) |
| **Base légale** | intérêt légitime de l'équipe à relire ce qu'elle livre ; les données personnelles sont remplacées par des fausses avant toute publication |
| **Personnes** | celles dont les données sont dans la base de développement que l'app affiche (comptes de test, jeux de données copiés) ; aucune vraie valeur ne quitte la machine qui a pris la capture |
| **Destinataires** | qui voit le dépôt sur la forge (une PR d'un dépôt privé ne rend pas ses images publiques), et sur le serveur d'équipe les membres du projet |
| **Sous-traitants** | aucun nouveau : la forge que l'équipe utilise déjà (GitHub, GitLab, Azure DevOps, Bitbucket). Seuls les moteurs d'OCR **locaux** lisent une capture : elle n'est jamais envoyée à un OCR dans le cloud |
| **Transferts hors UE** | ceux de la forge de l'équipe, déjà à son registre ; ce traitement n'en ajoute pas |

## Ce qui est pris, gardé et publié

| Donnée | Où | Contenu | Durée |
|---|---|---|---|
| Capture d'origine | `<spec>/captures/{base,task}/` sur la machine qui l'a prise (le poste, ou le clone du serveur) | l'écran tel qu'affiché, données de la base de développement comprises | celle de la carte : partie avec le dossier de la carte quand elle est supprimée, avec son worktree quand il est retiré |
| Copie publiable | `<spec>/captures/published/` | la même image **ré-encodée depuis les pixels** (aucune métadonnée, ni EXIF ni texte PNG), chaque valeur personnelle remplacée par une fausse du même type et du même format (e-mail, téléphone, IBAN, carte, nom, adresse, date de naissance, secret) | même durée |
| Clé de pseudonymisation | `<spec>/captures/.pseudonym-key` (`0600`) | une clé aléatoire par tâche : la même vraie valeur donne le même faux sur toutes les captures de la tâche ; sans elle, personne ne relie un faux à une vraie valeur | même durée ; jamais publiée, jamais dans une PR |
| Liste de publication | `<spec>/captures/publication.json` | par écran : statut de la vérification, nombre de valeurs remplacées, **types** trouvés ; jamais une valeur | même durée |
| Images dans la PR (GitHub, GitLab, Bitbucket) | branche à part du dépôt, `CAPTURES_BRANCH` (`workpilot-captures`), sans historique commun avec le code | les copies publiables seulement | `CAPTURES_RETENTION_DAYS` jours après la dernière mise à jour de la tâche (**30** par défaut, `0` : sans limite) ; une tâche plus vieille est retirée de la branche au passage suivant |
| Images dans la PR (Azure DevOps) | pièces jointes de la PR (`wp-capture-…`) | les copies publiables seulement | retirées à la synchronisation suivante quand elles ne sont plus montrées ; sinon, la vie de la PR |
| Section « Captures » | corps de la PR | un tableau Avant / Après et une ligne qui dit que les données personnelles sont des faux | remplacée à chaque synchronisation, retirée quand plus rien n'est à montrer |
| Publication par une personne (mode `review`) | `<spec>/captures/approval.json`, et sur le serveur `audit_log`, actions `task.captures.published` et `task.captures.withdrawn` | les empreintes des images publiées, la date ; à l'audit, qui, quelle carte, combien d'images | celle de la carte ; l'audit, son historique |

Une capture dont aucune vérification n'a pu tourner (`unchecked`) ou dont une valeur n'a pas pu
être remplacée (`withheld`) **reste sur la tâche** : elle n'est ni publiée ni servie au téléphone.
`CAPTURES_PUBLISH_UNCHECKED=true` et `CAPTURES_MASK=false` sont des choix de l'équipe, à inscrire
au registre s'ils sont pris : la section de la PR le dit alors en clair.

**Jamais publié** : une capture d'origine, une vraie valeur, la clé, la liste des valeurs
trouvées, un nom de fichier de la base de développement. Ce qu'aucun motif ne reconnaît (un nom
écrit en texte libre) reste un risque : l'équipe marque ces endroits avec `data-private` ou ses
propres sélecteurs (`CAPTURES_MASK_SELECTORS`).

## Après la suppression

Une image retirée de la branche des captures n'est plus atteignable depuis elle. La forge peut
encore la garder un temps dans ses caches ou tant qu'elle n'a pas nettoyé ses objets git ; une PR
fermée garde son corps. Pour effacer plus tôt : **Retirer** (mode `review`) enlève la section et
les images de la PR au passage suivant, `CAPTURES_RETENTION_DAYS` plus court purge la branche plus
tôt, et supprimer la branche `workpilot-captures` sur la forge efface tout d'un coup (la suivante
publication la recrée).

## En mode serveur et sur le téléphone

Sur le serveur d'équipe, la tâche tourne sur le clone du serveur : captures, copies et clé y
restent, dans le dossier de la carte. L'app mobile et l'app de bureau connectée lisent, par
`project_id` et jamais par chemin :

| Route | Permission | Ce qu'elle rend |
|---|---|---|
| `GET /api/board/cards/{id}/captures` | `task.read` (membres du projet, lecteurs compris) | la liste de publication sans chemin, empreinte ni valeur : types remplacés, statut, état de la PR |
| `GET /api/board/cards/{id}/captures/{n}/{before\|after}` | `task.read` | une copie publiable, en PNG base64 ; jamais une capture d'origine ni une copie retenue |
| `POST /api/board/cards/{id}/captures/publish`, `…/withdraw` | `review.approve` et rôle de membre | la réponse à la revue des captures, inscrite à l'audit |
| run `captures` (`POST /projects/{id}/specs/{spec}/runs`) | `agent.execute` et `vcs.pr.create` | met les images dans la PR ou les en retire, avec le jeton de forge de qui le lance |

Le téléphone ne garde aucune image : il la demande quand l'écran l'affiche et l'oublie en le
quittant.

## Les droits des personnes

Les personnes dont les données figurent dans une base de développement n'apparaissent dans une PR
que sous des faux sans lien avec elles. Leurs droits s'exercent sur la base de développement
elle-même ; les captures d'origine partent avec la carte. Une équipe qui copie des données réelles
dans une base de développement l'inscrit à son registre pour cette copie : les captures n'en sont
qu'un affichage.
