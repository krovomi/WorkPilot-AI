---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F2a (gestionnaire d'identifiants)** : le service qui choisit le fournisseur actif, teste une connexion et prépare l'environnement du backend passe de 9 % à 100 % (instructions, branches, fonctions, lignes). Les fichiers de réglages et de profils sont tenus en mémoire, les API des fournisseurs répondent par un `fetch` simulé, le serveur LLM local est un vrai serveur HTTP, et la base `state.vscdb` de Windsurf est un vrai fichier SQLite.
- **Test de connexion des profils préréglés** : un profil OpenAI, Mistral ou DeepSeek dont l'URL finit par `/v1` (c'est le cas des profils proposés par l'app) était testé sur `/v1/v1/models`, une 404 : le test échouait avec une clé valide. La vérification des identifiants actifs avait le même défaut.
- **Compte Claude reconnu** : le test de connexion Anthropic ne regardait que le profil Claude actif. La recherche dans les autres profils appelait une méthode qui n'existe pas (`getProfiles`) : un profil connecté qui n'était pas l'actif n'était jamais trouvé, et le test disait « non authentifié ».
- **Fournisseur choisi par une page** : un choix vide n'efface plus le fournisseur des réglages ; le processus partait sans `SELECTED_LLM_PROVIDER` et retombait sur Claude.
- Code jamais exécuté retiré : des `try`/`catch` autour d'appels qui ne rejettent jamais, un cas Ollama et un cas Windsurf que la fonction ne pouvait plus atteindre, deux variables jamais lues. Le gestionnaire de profils Claude est importé pour de bon, et `better-sqlite3` est chargé par un petit module à lui : un `require` au milieu d'une fonction échappait aux tests.
