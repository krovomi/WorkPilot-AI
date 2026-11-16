---
section: 🧪 Filets de test
---

- **Composants du frontend, deuxième lot** : la configuration GitHub d'un projet, l'indicateur d'usage et son détail (Claude, OpenAI, Copilot), l'ajout d'un projet avec un remote et la fenêtre de limite d'usage sont rendus et utilisés par leurs tests.
- **Configuration GitHub** : ouvrir la fenêtre ne la fait plus tourner en boucle, et le nom d'un nouveau dépôt ne perd plus le focus à chaque lettre tapée.
- **Ajout d'un projet** : le provider choisi juste après avoir tapé l'emplacement n'est plus remis sur « Plus tard » ; les URL de clone Azure DevOps (`https://org@dev.azure.com/…`) sont reconnues ; enregistrer un remote pour un dossier qui existe déjà mène au résumé au lieu d'une fenêtre Git qui fermait l'assistant sans créer le projet ; une URL collée en `.git` ne donne plus son suffixe au nom ; une erreur ne s'affiche plus deux fois.
- **Limite d'usage** : une fois ouverte, la fenêtre ne remet plus le compte suggéré à la place de celui qu'on choisit ; « Ajouter un compte » place bien le curseur dans le champ du nom, quelle que soit la langue.
- **Indicateur d'usage** : avec OpenAI sans données, l'infobulle n'affiche plus un bloc de débogage vide.
- **Messages traduits** : les erreurs de la configuration GitHub, les visibilités du dépôt lues par un lecteur d'écran et le nom de l'opération interrompue par une limite d'usage s'affichent en français.
