# Collaboration d'équipe : qui est là, qui tient quelle carte, le chat, les conflits

Sur un projet du serveur (mode serveur), le tableau montre l'équipe : qui le regarde en ce moment,
quelle carte est tenue par qui, un chat d'équipe enregistré, et des notifications quand un
coéquipier arrive, prend ou libère une carte, ou quand l'un de ses runs se termine. Une
modification de carte qui croise celle d'un coéquipier est arbitrée au lieu d'écraser l'autre.

Les composants (`components/collaboration/`) existaient sans transport : un store local qui
n'envoyait rien et ne recevait rien, monté nulle part. Ils sont branchés sur ce que le mode
serveur avait déjà : le flux du projet (`project:<id>`), ses droits par projet, et les claims des
cartes.

```
apps/backend/streaming/project_room.py      la salle d'un projet : présence, chat, débit
apps/backend/server/services/team_chat.py   un message : nettoyé, enregistré, relu
apps/backend/server/db/models.py            TeamChatMessage (migration 0012_team_chat)
apps/frontend/src/main/server-team-room.ts  la salle côté app : flux, claims, contrôles
apps/frontend/src/main/server-board-actions.ts  reconcileEdit : une modification face à celle d'un autre
apps/frontend/src/renderer/stores/collaboration-store.ts
apps/frontend/src/renderer/components/collaboration/  barre d'équipe, chat, badge de claim, conflit, réglages
```

## Ce que le serveur envoie

Le serveur WebSocket tient, par canal `project:<id>`, la salle des **personnes** connectées : ni
le jeton de service de l'API ni celui d'un run n'y figurent. Sur le même flux que les événements
du tableau :

| Événement | À qui | Contenu |
|---|---|---|
| `presence` | toute la salle, à chaque arrivée ou départ | `users: [{id, name}]`, une fois par personne, jamais d'e-mail |
| `chat_history` | celui qui arrive | les 100 derniers messages, du plus ancien au plus récent |
| `chat_message` | toute la salle, auteur compris, une fois enregistré | `id, author_id, author, message, reply_to, at` |
| `chat_rejected` | l'auteur seul | `forbidden` (lecteur), `invalid`, `too_fast` (5 messages en 5 s), `unavailable` |

Écrire demande le rôle `member` du projet (`ChannelGrant.can_interact`, déjà calculé à
l'ouverture du canal) ; un `viewer` lit. Un message est du texte (2 000 caractères au plus, sans
caractères de contrôle), enregistré dans `team_chat_messages` : le chat survit à un redémarrage.
Une réponse à un message d'un autre projet perd sa référence. Le mode local n'a pas de salle :
le chat d'une session de streaming garde son chemin.

## Ce que l'app en fait

Tant qu'un tableau serveur est affiché, la fenêtre est dans sa salle (`TeamRoomBar` dans la barre
du Kanban). Le main tient le flux, revérifie et borne chaque événement avant de l'envoyer à la
fenêtre (`parseRoster`, `parseChatMessage`, `parseLocks`), et n'envoie un message du chat que
sur un flux ouvert d'une salle rejointe.

- **Présence** : les avatars de la barre ; le premier roster d'une connexion sert de base, les
  suivants donnent les arrivées et départs (jamais les miens).
- **Claims** : relus dans l'index des cartes (`GET /projects/<id>/specs`) à l'ouverture du flux
  et après un événement de carte (regroupés sur 300 ms). Le badge d'une carte nomme qui la tient ;
  « Libérer » passe par la route du serveur, qui ne l'accepte que du détenteur ou d'un
  propriétaire du projet.
- **Conflits** : la boîte d'édition garde le titre et la description tels qu'à l'ouverture
  (`base`) et ne se réinitialise plus quand la même carte change pendant qu'elle est ouverte.
  `reconcileEdit` relit la carte : un champ que la personne n'a pas touché n'est pas envoyé (le
  changement du coéquipier reste), un champ que les deux ont changé revient en conflit. Selon le
  réglage : demander (les deux versions côte à côte), garder la mienne (rien n'est vérifié),
  garder la sienne (ses champs restent, mes autres changements partent).
- **Notifications** : toasts pour les arrivées, claims, fins de run d'un coéquipier, mentions
  `@nom` dans le chat ; chaque type se coupe dans Réglages → Collaboration d'équipe, gardé sur
  cet ordinateur.

## Ce qui reste vrai

- Le contenu d'un message est une donnée : affiché comme texte, jamais comme balisage ni comme
  instruction à un agent.
- Le renderer ne donne qu'un id de projet listé, un texte et un id de tâche ; le jeton reste dans
  le main. Le serveur décide qui écrit et qui libère.
- La comparaison d'une modification se fait juste avant l'écriture : deux enregistrements dans la
  même fraction de seconde restent possibles, le dernier gagne.

## Limites

- La présence est celle du tableau affiché : un coéquipier sur une autre vue du projet n'y figure
  pas.
- Pas d'édition ni de suppression d'un message ; l'historique n'est pas purgé.
- L'app mobile n'a ni la présence ni le chat.
