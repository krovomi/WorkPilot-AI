---
section: ✨ Nouveautés
---

- **Mode code pour tous les fournisseurs de la boucle WorkPilot.** Un agent peut écrire un court
  script JavaScript (`run_script`) qui enchaîne ses outils en une étape : la même modification sur
  plusieurs fichiers, une recherche filtrée avant lecture, lint et tests lancés en parallèle. Il
  marche avec OpenAI, Google, Mistral, Copilot, Windsurf, Ollama, LM Studio, les fournisseurs
  compatibles et les passerelles. Arrêté par défaut : Paramètres, Mode code (Arrêté, Auto, Activé) ;
  une tâche peut le choisir pour elle ou par phase. Chaque appel du script passe les mêmes contrôles
  qu'un appel direct, et la surveillance des anomalies les compte tous. Le banc de rejeu mesure ce
  qu'il change (cartes résolues, coût, durée) en rejouant chaque moteur sans lui et avec lui.
