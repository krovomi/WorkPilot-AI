---
section: 🧪 Filets de test
---

- **L'IA du tableau testée de bout en bout** : « Interroger le tableau » (réponse du modèle citant les tickets dans toutes les langues, question de suivi, repli par mots-clés puis par le sens avec un modèle d'embeddings local), « Vérifier une idée » jusqu'à la carte de ce qui manque, et « Proposer le sprint » (par les règles sans modèle, par le modèle avec dépendances et capacité vérifiées) tournent maintenant dans l'app construite contre un faux serveur Ollama, sans réseau ; le test vérifie aussi que le modèle ne lit les tickets que comme des données et jamais le nom de qui les a écrits.
