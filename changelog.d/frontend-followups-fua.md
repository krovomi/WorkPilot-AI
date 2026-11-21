---
section: 🐛 Corrections
---

- **Carte du Kanban** : quand le tableau donnait à une carte une nouvelle action (clic, changement de statut, sélection, suppression…) sans que la tâche ait changé, la carte gardait l'ancienne. Elle utilise toujours la dernière.
- **Phase en cours** : la pastille de phase de la carte (Planification, Codage, Révision…) suit la langue de l'app au lieu de rester en anglais.
- **Récupération d'une tâche bloquée** : un échec de la récupération s'affiche dans une notification avec sa raison ; la carte reste marquée bloquée.
- **Téléchargement d'un modèle local** : le temps restant dans l'infobulle de la pastille de téléchargement est écrit dans la langue de l'app (« encore 3 min »).
- Code inutilisé retiré : l'ancien bloc de progression du panneau de tâche, que plus rien n'affichait, et ses textes ; deux sélecteurs du store des téléchargements que rien n'appelait.
