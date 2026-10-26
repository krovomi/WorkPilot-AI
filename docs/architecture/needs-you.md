# « Besoin de toi » : notifications et approbation à distance

Une tâche qui attend quelqu'un ne servait à rien tant que personne ne regardait
l'écran. Les notifications du bureau existaient, mais elles venaient du code de
sortie du processus agent. Un plan qui attendait son approbation était annoncé
comme un échec : avec « revue avant le code », `spec_runner` sort en 1 (« spec
not approved »). Une QA qui passait la main sans planter n'était pas annoncée du
tout.

« Besoin de toi » lit l'état où la tâche s'arrête, dans la machine XState. Il
envoie l'annonce sur le bureau, et en plus sur ntfy ou Telegram si on le
demande. Un plan en attente peut être approuvé depuis Telegram, par un bouton à
usage unique.

```
apps/frontend/src/main/needs-you/
  events.ts           les moments qui appellent quelqu'un, et leurs textes en/fr
  approvals.ts        les jetons d'approbation : une tâche, une action, une fois, 30 min
  channels.ts         ntfy et Telegram, réglages validés là où ils servent
  telegram-poller.ts  les appuis sur le bouton, récupérés par polling
apps/frontend/src/main/notification-service.ts      le répartiteur
apps/frontend/src/main/task-state-manager.ts        announce() : la source des événements
apps/frontend/src/renderer/hooks/useNeedsYou.ts     ouvrir la tâche ; appliquer l'approbation
apps/frontend/src/renderer/components/settings/NeedsYouChannels.tsx
```

## Les moments

| État XState | Raison | Annonce | Interrupteur existant |
|---|---|---|---|
| `plan_review` | | Un plan t'attend | « revue nécessaire » |
| `human_review` | `completed` | Prête pour ta revue | « tâche terminée » |
| `human_review` | `qa_rejected` | La QA a besoin de toi | « revue nécessaire » |
| `human_review` | `qa_unverified` | La QA n'a pas conclu | « revue nécessaire » |
| `error`, ou `human_review` + `errors` | | Tâche arrêtée sur une erreur | « tâche échouée » |
| `human_review` | `stopped` | rien : la personne a arrêté, elle regarde | |

- **Une transition, pas un état.** Un état restauré depuis le disque au
  démarrage n'est pas annoncé : l'app qui s'ouvre ne doit pas sonner pour chaque
  carte qui attend déjà.
- **La sortie en 1 au moment du plan.** Elle n'est plus lue comme un échec,
  ni par la notification ni par la carte. `handleProcessExited` laisse un
  `plan_review` tel quel : c'est la fin normale d'un run de planification.

## Les canaux

Tout part de la machine vers l'extérieur. Rien n'écoute sur la machine : pas de
port ouvert, pas de tunnel.

- **ntfy.** Notification seulement : quiconque connaît un topic peut y publier,
  donc un topic ne peut pas porter de réponse.
  - Sur `ntfy.sh`, le topic est le seul secret : un topic de moins de 16
    caractères est refusé. Les réglages en génèrent un de 34.
  - Le jeton d'accès ne part qu'en HTTPS, ou en HTTP vers la boucle locale.
  - Pas d'identifiants dans l'URL, pas de redirection.
- **Telegram.** Le bot de la personne, créé avec @BotFather, lui écrit dans une
  conversation privée.
  - Le message est en texte brut : un titre de tâche est du texte, pas du
    balisage.
- **Ce qui part.** Le titre de la tâche et le type d'attente. Le détail d'une
  erreur reste sur le bureau, parce qu'il peut contenir des chemins et des
  morceaux de sortie.
- **Les jetons.** Ce sont des secrets de l'app (`globalNtfyAccessToken`,
  `globalTelegramBotToken`), chiffrés sur le disque et masqués pour le renderer
  (S6).
  - Le bouton de test envoie depuis les réglages enregistrés, dans le main.

## L'approbation à distance

Seul un plan en attente s'approuve de loin. Approuver un plan lance le code
dans le worktree de la tâche, et un reset le défait. La revue d'une tâche finie
mène à un merge, que rien ne défait : elle passe toujours par l'app.

Un appui approuve seulement si chacune de ces conditions tient :

1. **La personne.** L'appui vient du chat configuré et de l'utilisateur
   configuré : quelqu'un ajouté à un groupe ne peut pas approuver.
2. **Le jeton.** C'est un jeton émis par cette app, jamais utilisé et pas
   expiré.
   - Il dure 30 minutes et ne vit qu'en mémoire.
   - Un nouveau message pour la même tâche annule l'ancien bouton.
   - Le jeton est annulé dès que la tâche quitte `plan_review`.
3. **La tâche attend encore.** C'est vérifié dans le main au moment de l'appui
   (`isInPlanReview`), puis par le renderer, qui joue les deux étapes du bouton
   Approuver : `submitReview` puis `startTask`.

- **Ce que voit la personne.** Telegram répond par le résultat : approuvé, plus
  en attente, expiré, ou app fermée.
- **Après l'appui.** Le bouton est retiré dans tous les cas.
- **Sans fenêtre ouverte**, rien n'est approuvé.

## Limites connues

- Le polling Telegram (`getUpdates`) prend la main sur le bot : un bot déjà
  branché sur un webhook ailleurs ne reçoit pas les appuis. Il faut un bot
  dédié.
- ntfy n'a pas de bouton d'approbation, par construction.
- Une app fermée ne notifie pas : les événements viennent de la machine d'état
  du main.

## Vérifier

```
cd apps/frontend && pnpm test -- needs-you notification-service task-state-manager NeedsYouChannels useNeedsYou
```
