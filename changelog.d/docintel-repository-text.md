---
section: 🐛 Corrections
---

- **Documents du dépôt dans le prompt** : les titres et décisions des ADR et les libellés d'un
  diagramme d'architecture sont lus comme une pièce jointe (vérifiés, sur une ligne) avant
  d'être cités ; une modification d'exigence que le masquage ne sait pas lire n'est pas
  enregistrée, la proposition reste.
- **Carte d'architecture** : la description de la tâche est citée comme une donnée, et les noms
  de fichiers et de dépendances du dépôt restent sur leur ligne dans le prompt.
- **Mémoire partagée** : l'avis demandé à un modèle sur deux notes cite aussi comme une donnée ce
  que le détecteur a relevé dans ces notes.
