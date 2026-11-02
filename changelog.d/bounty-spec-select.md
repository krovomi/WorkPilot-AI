---
section: 🐛 Corrections
---

- **Bounty Board : la spec se choisit dans la liste des specs du projet**. Le champ « Identifiant de spec » acceptait n'importe quel texte quand la liste était vide, et un round pouvait partir sur une spec qui n'existe pas. Il n'y a plus de saisie libre : la liste ne montre que les specs du projet courant (désactivée avec un message s'il n'en a aucune), et le processus principal refuse un identifiant qui ne désigne aucun dossier de spec.
