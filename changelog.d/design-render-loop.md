---
section: ✨ Nouveautés
---

- **Import Design compare son code à la maquette et le corrige** (#379). Après la génération,
  le code est rendu dans un navigateur sans réseau ni JavaScript, comparé à l'image zone par
  zone, puis corrigé par le modèle de vision du provider choisi, jusqu'à cinq fois ou jusqu'au
  seuil de ressemblance. La meilleure version est gardée ; un panneau montre le score de chaque
  itération, la cible, le rendu, la carte des différences et les écarts restants. En hors-ligne
  strict, seule une vision locale (Ollama) est utilisée.
