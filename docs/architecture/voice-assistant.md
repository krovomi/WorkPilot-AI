---
feature: Assistant vocal
summary: >-
  Raccourci global, Whisper local, commandes simples lues localement puis modèle « Assistant vocal
  » ; liste fermée d'actions (vue de la barre latérale, tâche après confirmation, réglages),
  réponse revalidée dans le main. Écoute continue avec détection de la voix calibrée, et « stop »
  qui arrête les tâches après l'appel d'outil en cours.
---

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
  VoiceContinuous.tsx     l'écoute continue : voyant, phrase en cours, micro coupé
  use-voice-capture.ts    une phrase par la dictée locale, fin sur un silence
  use-continuous-capture.ts  une session de dictée gardée ouverte, phrase après phrase
  voice-activity.ts       la détection de la voix (énergie, plancher de bruit calibré)
  voice-resolve.ts        d'une phrase à ce qu'on fait (stop, lecture locale, modèle)
  voice-stop.ts           « stop », « oui », « non » lus sans modèle
  voice-intent.ts         la lecture locale (fr, en), sans modèle
  voice-destinations.ts   à quoi sert chaque vue (mots et description)
  voice-language.ts       la langue de transcription choisie dans le panneau
apps/frontend/src/renderer/stores/voice-assistant-store.ts ouvert ou non ; second appui
apps/frontend/src/main/voice-assistant/
  interpret.ts            la requête bornée, le prompt, la réponse revalidée
  global-shortcut.ts      l'enregistrement auprès de l'OS (option)
apps/frontend/src/main/ipc-handlers/voice-assistant-handlers.ts
apps/frontend/src/main/ipc-handlers/task/stop-after-step-handlers.ts   « stop » : pause après l'étape
apps/backend/agents/tool_breaker.py                                   où la session s'arrête
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

## Distinguer la voix du bruit

`voice-activity.ts` décide, pour chaque trame de 4 096 échantillons (environ 0,1 s), si
c'est de la parole. Sur l'énergie (RMS) que `captureDictation` mesurait déjà : ni modèle,
ni dépendance. Les quatre premières trames fixent le plancher de bruit (la plus calme
l'emporte) ; ensuite il tombe tout de suite sur une trame plus calme et monte lentement
vers le niveau de la pièce tant que personne ne parle, si bien qu'un ventilateur allumé
ne compte pas longtemps comme une voix. Une trame est de la parole quand elle dépasse le
plancher d'un facteur que la personne choisit (Paramètres → Assistant vocal →
Sensibilité : faible ×4, moyenne ×2,5, élevée ×1,6, `voiceAssistantSensitivity`), avec un
minimum absolu. Un morceau sans aucune trame parlée n'est jamais envoyé à Whisper, ce qui
lui évite d'inventer une phrase dans le silence. La dictée des tickets garde son seuil fixe.

## Écoute continue

Le panneau propose « Écoute continue » : il se ferme et un encadré reste en bas à droite,
au-dessus de toutes les vues. Il montre un voyant rouge qui pulse tant que le micro est
ouvert, ce qui est en train d'être transcrit, et deux boutons : couper le micro, arrêter
l'écoute. C'est un choix de la personne à chaque fois ; rien ne l'allume au démarrage.

Une seule session de dictée reste ouverte tant que le mode tourne
(`use-continuous-capture.ts`) : le modèle Whisper se charge une fois, pas à chaque
phrase. Une phrase se termine sur 1,6 s de silence après de la parole, ou après 30 s de
parole : le son pas encore envoyé part (`flush`), puis la phrase est lue comme dans le
panneau (`voice-resolve.ts`). Ouvrir une vue, ouvrir le formulaire ou les réglages se
fait sans quitter le mode ; créer une tâche ou arrêter les agents attend un « oui »
(ou le bouton), et toute autre phrase remplace la question. Le micro se coupe pendant
que le panneau est ouvert (une seule dictée à la fois) et reprend à sa fermeture.

## « Stop » : arrêter les agents après leur étape

« Stop », « arrête tout », « stop the agents »… (`readStopCommand`, une phrase courte faite
de ces mots, dans les langues du panneau) ne passe jamais par le modèle et demande
toujours confirmation. Confirmé, `AGENTS_STOP_AFTER_STEP` (sans argument) écrit sur chaque
tâche en cours la même pause que le bouton Pause (`pause_state.json` dans chaque copie de
sa spec, `reason: "voice_stop"`), mais sans arrêter son processus.

Le backend lit ce fichier après chaque résultat d'outil, dans le flux que tous les
fournisseurs traversent (`agents/tool_breaker.py`, appelé par les deux boucles de
`agents/session.py`) : la session se termine là, donc l'appel en cours finit et le
suivant ne part pas. La boucle du coder, de la QA ou de la spec voit ensuite la pause à
son point de contrôle et remonte `BuildPaused`, comme pour le coupe-circuit. La carte
affiche « Arrêtée à la voix après son étape » ; Reprendre est le bouton habituel, et le
prochain lancement de l'app ne la reprend pas tout seul. Un agent qui n'est pas une tâche
(idéation, feuille de route…) n'a pas d'étape après laquelle s'arrêter : « Arrêter tous
les agents » reste le bouton pour eux. Un agent qui réfléchit longtemps sans appeler
d'outil s'arrête à la fin de sa session.

## Mode serveur

Sur un projet du serveur, l'assistant crée la carte sur le serveur et n'offre
que les vues que le serveur partage. La dictée et l'interprétation tournent sur
l'ordinateur de la personne, avec son fournisseur. L'app mobile n'a pas
d'assistant : le clavier du téléphone dicte déjà dans le formulaire de carte.

## Pas encore fait (lots suivants de #385)

- Le retour vocal (synthèse : Piper en local, ou un service du fournisseur), muet, court ou
  bavard.
- Le mot d'éveil (« Hey WorkPilot »), seulement quand l'écoute continue est éteinte.
- La détection automatique de la langue parlée (Whisper la donne) pour adapter la lecture.
- Le mode binôme : une session vocale où l'agent explique ce qu'il fait pendant qu'il code.
- Une pédale ou un périphérique HID pour activer le micro.
- La dictée des tickets pendant l'écoute continue : il faut couper le micro d'abord.

## Tests

`voice-intent.test.ts`, `voice-shortcut.test.ts`, `interpret.test.ts`,
`global-shortcut.test.ts`, `VoiceAssistant.test.tsx` (raccourci depuis un champ,
navigation sans modèle, confirmation puis création, passage au modèle, absence
de modèle, téléchargement), `VoiceAssistantSettings.test.tsx` (enregistrement,
refus, AltGr, interrupteur, sensibilité), `voice-activity.test.ts`, `voice-stop.test.ts`,
`voice-resolve.test.ts`, `VoiceContinuous.test.tsx`, `VoiceAssistant.stop.test.tsx`,
`stop-after-step-handlers.test.ts`, `tests/agents/test_tool_breaker_pause.py` (sur le flux
normalisé et sur le flux du SDK Claude).
