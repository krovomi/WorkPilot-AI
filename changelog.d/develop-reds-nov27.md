---
section: 🧹 Maintenance
---

- **CI de develop remise au vert** : le faux environnement du test d'arrêt d'urgence suit la nouvelle signature (projet passé à l'environnement du run) ; la lecture JSON des vagues refuse un lien aussi sous Windows, qui n'a pas `O_NOFOLLOW` ; le test des droits du fichier de run attend ce que Windows donne ; ruff à la racine ignore les packs de skills épinglés à l'amont et la sortie générée `.agents/`, comme déjà BMAD.
