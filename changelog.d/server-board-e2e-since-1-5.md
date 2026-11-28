---
section: 🐛 Corrections
---

- **Mode serveur : les captures d'une carte serveur s'affichent dans l'app de bureau.** L'onglet Captures
  disait « This copy could not be read » pour chaque image : l'app cherchait les copies publiées dans son
  miroir, qui n'en a pas. Elle les demande maintenant au serveur, une à une, par leur place dans la liste.
- **Mode serveur : « Interroger le tableau » répond depuis le téléphone même sans modèle sur le serveur.**
  Sans jeton ni clé pour le provider du projet, la question échouait ; le serveur répond désormais par
  les mots des cartes, comme l'app de bureau sans modèle.
