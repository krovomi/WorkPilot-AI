---
section: 🐛 Corrections
---

- **Les panneaux, cartes et bordures de 24 vues réapparaissent et suivent le thème.** API Explorer, Self-Healing, Browser Agent, Context Mesh, Live Companion, Code Migration, CI/CD Triggers et d'autres écrivaient leurs couleurs avec des variables qu'aucun thème ne définit : le fond et les bordures disparaissaient et le texte secondaire n'était pas atténué. Elles utilisent maintenant les couleurs du thème actif.
