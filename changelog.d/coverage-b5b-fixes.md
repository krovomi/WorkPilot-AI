---
section: 🐛 Corrections
---

- **Streaming, enregistrements** : une session enregistrée garde enfin ses événements. L'enregistreur était démarré, mais aucun événement n'y entrait, et chaque fichier sous `~/.workpilot/recordings` ne contenait que l'en-tête. Les événements émis quand le serveur est injoignable sont gardés aussi, et un identifiant de session devient un nom de fichier valable sous Windows.
- **Streaming, rejeu** : chaque événement attend l'écart qui le séparait du précédent. Il attendait l'écart depuis le premier, si bien qu'une session de dix minutes durait bien plus au rejeu. Une vitesse nulle ou négative est refusée.
- **Streaming, origine refusée** : une page d'une autre origine reçoit un vrai `403`. Le serveur répondait par une réponse invalide, que le client lisait comme une panne.
- **Mission Control** : mettre en pause un agent qui ne tourne pas, ou reprendre un agent qui n'est pas en pause, n'écrit plus d'événement dans le journal. Le chemin de décision d'un agent inconnu répond `404`, et une limite nulle ou négative rend un journal vide.
- **Barre d'état (ccstatusline)** : le script lancé par son chemin retrouve le paquet `ui`. Il échouait à l'import.
- **Interface en terminal** : Ctrl+C interrompt un menu, une touche spéciale n'y choisit plus d'option, une barre de progression au-delà de 100 % reste de la bonne largeur, une ligne colorée tronquée dans un cadre referme sa couleur et garde le cadre droit, et un fichier d'état illisible ne fait plus planter la barre d'état.
