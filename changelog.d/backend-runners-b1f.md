---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1f (runners)** : Hermes, le serveur MCP UI/UX, le générateur de pipelines CI, le suivi de PR et le Code Playground passent à 100 %, lancés comme l'application les lance ; seuls les appels à un modèle et à `gh` sont remplacés par une doublure.
- **Le générateur de pipelines CI répond de nouveau** : il importait un module de session qui n'existe pas et plantait dès qu'il appelait le modèle. Il passe par la session des agents et lit sa réponse.
- **L'analyse IA de Context Mesh renvoie son résultat** : elle lisait la réponse de la session avec le mauvais nombre de valeurs et rendait toujours une analyse vide.
- **Le Code Playground choisit un modèle encore servi** : sans modèle choisi, il demandait un identifiant Sonnet retiré, écrit en dur. Il prend désormais le Sonnet configuré par l'utilisateur. Une réponse qui ouvre un objet JSON sans le fermer ne fait plus planter le runner : elle devient une page simple, comme toute réponse illisible.
