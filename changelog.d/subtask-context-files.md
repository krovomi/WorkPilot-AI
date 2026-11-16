---
section: 🐛 Corrections
---

- **Extraits de fichiers du codeur** : les fichiers qu'une sous-tâche cite et que le prompt du
  codeur reprend passent par les mêmes règles de lecture que le reste du projet (fichiers texte
  du projet, de taille bornée), et sont cités comme des données.
- **Cache de documentation des bibliothèques** : seules les pages rangées dans le dossier du
  cache sont servies ; une entrée d'index qui désigne un autre fichier est ignorée.
