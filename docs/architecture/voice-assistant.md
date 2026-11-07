# Assistant vocal

Un raccourci clavier, partout dans l'app, ouvre un panneau qui écoute. On dit ce
qu'on veut (« crée-moi une tâche dans le Kanban pour ajouter un export CSV »,
« ouvre la fonctionnalité qui me permet de dessiner une architecture »), et
l'assistant le fait avec les actions que l'app offre déjà.

L'entrée « Contrôle vocal » qui existait avant était factice : son runner
(`voice_control_runner.py`) n'enregistrait rien et renvoyait une phrase tirée
au hasard dans une liste d'exemples. Elle est remplacée, avec son service, ses
dix canaux IPC et son dialogue.

```
apps/frontend/src/shared/utils/voice-shortcut.ts          le raccourci : accélérateur Electron, refus, affichage
apps/frontend/src/renderer/components/voice-assistant/
  VoiceAssistant.tsx      le panneau et l'écoute du raccourci dans la fenêtre
  use-voice-capture.ts    une phrase par la dictée locale, fin sur un silence
  voice-intent.ts         la lecture locale (fr, en), sans modèle
  voice-destinations.ts   à quoi sert chaque vue (mots et description)
apps/frontend/src/renderer/stores/voice-assistant-store.ts ouvert ou non ; second appui
apps/frontend/src/main/voice-assistant/
  interpret.ts            la requête bornée, le prompt, la réponse revalidée
  global-shortcut.ts      l'enregistrement auprès de l'OS (option)
apps/frontend/src/main/ipc-handlers/voice-assistant-handlers.ts
apps/frontend/src/renderer/components/settings/VoiceAssistantSettings.tsx
```

## Le raccourci

Par défaut **Ctrl+Shift+Espace** (⇧⌘Espace sur macOS), stocké comme un
accélérateur Electron (`CommandOrControl+Shift+Space`) dans
`settings.voiceAssistantShortcut`. Aucun raccourci de l'app ne l'utilise, ni le
menu par défaut d'Electron, ni le terminal (xterm), ni le Kanban.

Le renderer l'écoute en phase de capture sur `window` : il marche aussi quand le
focus est dans un champ ou un terminal, avant que le champ ne voie la touche.
Seul l'enregistreur des réglages (`data-shortcut-recorder`) le laisse passer.

Un raccourci choisi dans Paramètres → Assistant vocal est refusé s'il masquerait
un raccourci existant (`shortcutConflict` : Ctrl+K, Ctrl+N, Ctrl+1…9, Ctrl+T,
Ctrl+W, Ctrl+Shift+C/V du terminal, Ctrl+Shift+I des DevTools, copier-coller,
zoom…) ou s'il combine Ctrl et Alt : c'est AltGr sur les claviers AZERTY et
QWERTZ (il tape `@`, `€`, `[`). Une touche seule ou Shift+touche reste de la
frappe, pas un raccourci. La lettre vient du caractère que la disposition
produit (le « A » d'un AZERTY est `A`), sauf quand un modificateur l'a changé
(Option+V tape « √ » sur macOS) : la touche physique la nomme alors.

**Même quand WorkPilot est en arrière-plan** (désactivé par défaut) : le main
enregistre aussi l'accélérateur avec `globalShortcut`, au démarrage et à chaque
enregistrement des réglages. L'appui ramène la fenêtre et envoie
`voiceAssistant:toggle`, écouté une fois pour la vie de la fenêtre par
`global-listeners.ts`. Un bureau qui refuse (une autre app tient la touche,
certains compositeurs Wayland, WSLg) laisse le raccourci de la fenêtre en
place ; la page des réglages affiche le refus. Deux appuis à moins de 250 ms
sont un seul appui vu deux fois (OS puis fenêtre).

Un second appui pendant l'écoute termine la phrase ; après une réponse, il
réécoute.

## De la voix au texte

La transcription réutilise la dictée locale des tickets
([kanban-dictation.md](../features/kanban-dictation.md)) : `faster-whisper`,
modèle `base` sur CPU, audio en mémoire, une session à la fois
(`dictation-handlers.ts`). Aucun abonnement ni clé n'est nécessaire. Le modèle
(environ 150 Mo) se télécharge depuis le panneau, une fois, sous la politique
hors ligne du projet sélectionné.

La phrase se termine seule après 1,6 s de silence suivant la parole, ou après
30 s, ou au clic sur Arrêter, ou à l'appui sur Entrée. Le texte reste
modifiable, et on peut taper une commande sans parler.

## Du texte à l'action

1. **Lecture locale** (`readVoiceCommand`) : les formules courantes en français
   et en anglais. « Crée-moi une tâche (dans le Kanban) pour… », « add a task
   to… » donnent une création ; « ouvre le Kanban », le nom d'une vue ou un mot
   de sa fonction (`voice-destinations.ts` : « dessiner », « diagramme »,
   « schéma » → Visuel vers Code) avec un verbe donnent une navigation ;
   « paramètres » ouvre les réglages. Les noms se comparent par mots entiers,
   sans accents. Quand la lecture est sûre, aucun modèle n'est appelé.
2. **Modèle** sinon : `voiceAssistant:interpret` envoie la phrase, la langue et
   les vues offertes (id, libellé, description en anglais) au modèle de la
   fonctionnalité « Assistant vocal » (`featureModels.voiceControl`, Haiku par
   défaut ; fournisseur, modèle et effort par `page-llm.ts`, page
   `voice-control`), par `runOneShotLLM`. Tous les fournisseurs passent.
3. **Repli** : sans réponse du modèle, la lecture locale incertaine sert si elle
   a trouvé quelque chose ; sinon le panneau dit qu'il n'a pas compris (et
   qu'aucun modèle n'a répondu, le cas échéant).

Les actions forment une liste fermée (`VoiceIntent`) : ouvrir une vue, créer une
tâche, ouvrir le formulaire de nouvelle tâche, ouvrir les réglages. Rien ne
lance, n'approuve, ne fusionne ni ne supprime une tâche, comme pour le serveur
MCP du tableau ([board-mcp.md](board-mcp.md)).

- **Ouvrir une vue** : seulement une vue que la barre latérale montre à ce
  moment (`visibleNavItems` : vues expérimentales masquées et vues d'un projet
  du serveur appliquées). Le main refuse une réponse du modèle qui en nomme une
  autre. L'ouverture passe par `handleNavClick`, donc les vues qui sont des
  dialogues s'ouvrent comme au clic.
- **Créer une tâche** : toujours après confirmation (titre et description
  modifiables), car la transcription se trompe. La création passe par
  `createTask` du store, c'est-à-dire `TASK_CREATE` : en local, ou sur le
  tableau du serveur pour un projet du serveur (`createServerCard`), pour
  l'équipe.

## Frontières

- La phrase est une donnée (règle 4) : elle arrive au modèle entre balises
  `<command>`, sans pouvoir fermer la sienne, et le prompt système interdit
  toute autre action que la liste.
- Le renderer n'est pas fiable (S6) : `parseInterpretRequest` borne la phrase
  (1 000 caractères), la langue, les vues (250, id `[a-z0-9-]`, libellés de
  120 caractères). `parseInterpretAnswer` ne rend qu'une action de la liste,
  avec un titre de 120 caractères et une description de 4 000 au plus.
- Le micro ne s'ouvre que pour le cadre principal de la fenêtre principale
  (`security/dictation-permission.ts`). Fermer le panneau coupe le micro et la
  session de dictée.

## Mode serveur

Sur un projet du serveur, l'assistant crée la carte sur le serveur et n'offre
que les vues que le serveur partage. La dictée et l'interprétation tournent sur
l'ordinateur de la personne, avec son fournisseur. L'app mobile n'a pas
d'assistant : le clavier du téléphone dicte déjà dans le formulaire de carte.

## Tests

`voice-intent.test.ts`, `voice-shortcut.test.ts`, `interpret.test.ts`,
`global-shortcut.test.ts`, `VoiceAssistant.test.tsx` (raccourci depuis un champ,
navigation sans modèle, confirmation puis création, passage au modèle, absence
de modèle, téléchargement), `VoiceAssistantSettings.test.tsx` (enregistrement,
refus, AltGr, interrupteur).
