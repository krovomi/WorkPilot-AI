---
section: 🐛 Corrections
---

- **Plusieurs features du desktop remarchent comme prévu.** Ouvrir une PR revue ne lance plus de processus Python en boucle pour le score qualité. Code Playground, Context Mesh, Learning Loop, Git en langage naturel, Live Companion, le module mobile et l'entretien de spec utilisent le Python de l'app au lieu de celui du système (absent sur un macOS ou un Windows neufs). Les réponses d'Insights gardent leurs lignes vides : paragraphes et blocs de code ne sont plus collés. Après une erreur, la création d'une tâche depuis une issue GitHub montre l'erreur et un bouton Fermer, et la suivante ne s'ouvre plus figée.
