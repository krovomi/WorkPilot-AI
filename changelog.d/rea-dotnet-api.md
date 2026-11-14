---
section: ✨ Nouveautés
---

- **API publique .NET gardée pendant une migration**. Après la QA d'une tâche .NET, chaque
  bibliothèque qu'elle touche est construite avant et après la tâche, dans des copies jetables, et
  REA compare les deux assemblies : un membre public retiré, rendu interne, renommé ou dont la
  signature change est signalé. Par défaut la porte prévient sans bloquer, et seulement si REA est
  installé ; pendant une migration .NET préparée par WorkPilot, ou quand le workflow déclare la
  porte dure `public-api-stable`, la rupture renvoie la tâche au fixer. Un build qui échoue ou un
  membre que REA n'a pas pu apparier n'est jamais compté comme réussi.
