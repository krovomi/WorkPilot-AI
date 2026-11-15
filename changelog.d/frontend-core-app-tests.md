---
section: 🐛 Corrections
---

- **Détection du fournisseur Git** : la détection GitHub / Azure DevOps des projets repartait à
  chaque rendu de la fenêtre (une lecture de configuration par projet à chaque fois) ; elle ne
  tourne plus que quand la liste des projets change.
- **Retirer un projet** : un retrait refusé fermait le dialogue comme s'il avait réussi, et
  ramenait au Kanban quand c'était le dernier projet ; le dialogue reste ouvert avec l'erreur.
- **Ajouter un projet avec Ctrl+T** : l'avertissement « dossier qui n'est pas la racine git »
  s'affichait en anglais ; il suit la langue de l'app.
