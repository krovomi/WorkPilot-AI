---
section: 🐛 Corrections
---

- **Instantanés de tâche** : une modification faite dans la même seconde que la précédente, sans
  changer la taille du fichier, entre bien dans l'instantané pris avant une session ou un retour
  arrière ; annuler un retour arrière remet donc toujours le dernier état.
