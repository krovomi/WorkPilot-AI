---
section: 🐛 Corrections
---

- **Le merge IA d'un fichier en conflit marche avec chaque provider** : Copilot, OpenAI, Ollama
  ou un modèle local fusionnent le fichier que les deux côtés ont changé, avec leur propre
  modèle ; le jeton Claude n'est plus exigé, et l'erreur affichée est celle du provider.
- **L'aperçu des conflits voit ce que deux tâches ont réécrit** : une fonction modifiée par deux
  tâches est signalée, dans chaque langage reconnu (Python, TypeScript, C#, Java, Go, Rust…),
  à la ligne changée ; la vérification des tâches parallèles avant un merge nomme enfin les
  fichiers qu'une autre tâche non fusionnée a aussi changés.
- **Lecture d'une tâche plus sûre** : un nom de fichier accentué ou un fichier qui n'est pas en
  UTF-8 ne cache plus les autres, et une sauvegarde interrompue garde l'enregistrement précédent.
- Le moteur de merge sémantique que rien n'appelait (pipeline, stratégies, résolveur, frise des
  fichiers) est retiré ; le merge passe par git, puis par le provider de l'utilisateur.
