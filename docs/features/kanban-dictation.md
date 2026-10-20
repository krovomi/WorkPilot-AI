# Dictée des tickets du Kanban

Les formulaires de création, de modification et de duplication proposent **Dicter**
près de la description. Choisir une langue, autoriser le microphone, puis parler.
Les phrases apparaissent après les pauses dans un brouillon séparé, modifiable
pendant l'écoute. Les nouvelles phrases s'ajoutent sans réécrire les corrections.

**Arrêter** coupe le microphone et termine les portions déjà enregistrées.
**Ajouter à la description** insère le brouillon à la fin du texte actuel, sans
remplacer les modifications clavier. **Annuler l'insertion** est disponible tant
que la description n'a pas changé depuis. Ajouter ou annuler le brouillon avant
de sauvegarder le ticket ou de passer à l'étape suivante.

## Moteur et langues

Le backend utilise `faster-whisper`, déclaré dans `apps/backend/requirements.txt`,
avec le modèle multilingue `base` sur CPU. Au premier usage, le bouton de
téléchargement prépare environ 150 Mo dans `userData/speech-models`. Le mode hors
ligne strict bloque ce téléchargement. Aucun téléchargement n'est déclenché par
le simple démarrage d'une dictée.

L'audio reste en mémoire et la transcription s'effectue localement. Le modèle
reste chargé pendant la session, puis le processus est arrêté. Aucun abonnement
LLM ni clé API n'est nécessaire.

Le sélecteur propose la détection automatique, le français, l'anglais, l'espagnol,
l'allemand et plusieurs autres langues. Les variantes régionales identifient la
langue du champ et le choix de l'utilisateur ; Whisper reçoit le code de langue
principal (par exemple `fr` pour `fr-CA`). Il n'existe pas de modèle distinct par
accent. La précision dépend de la voix, du microphone, du bruit et du vocabulaire.
La dictée transcrit dans la langue parlée, sans traduire en anglais.

## Vérification

Les tests couvrent l'édition concurrente, le curseur, l'insertion HTML échappée,
l'annulation, les sessions IPC, les limites audio et le nettoyage du microphone.
Le runner a aussi été exercé avec le modèle réel, hors ligne, sur trois WAV de
synthèse en français, anglais et espagnol. Cela ne constitue pas une validation
sur microphone physique ni une mesure de précision pour chaque accent.
