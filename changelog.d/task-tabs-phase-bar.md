---
section: ✨ Nouveautés
---

- **Barre de progression d'une tâche colorée par phase.** Dans le détail d'une tâche, la barre se
  découpe en planification (jaune), codage (bleu) et validation (violet), chaque segment à la part
  du temps passé dans la phase ; une légende donne le pourcentage et la durée de chacune (par
  exemple 30 % · 40 % · 30 %). La phase en cours scintille. Sans horodatage dans les logs, le
  découpage suit les tranches de progression (20 / 60 / 20).
- **Onglets du détail d'une tâche lisibles.** L'onglet sélectionné ressort dans tous les thèmes
  (soulignement épais à la couleur du thème, fond teinté, texte plein) et la ligne grise sous les
  onglets a disparu. La barre défile horizontalement quand la fenêtre est étroite.
- **Les couleurs de bordure s'appliquent enfin.** Une règle CSS globale forçait toutes les
  bordures au gris du thème : `border-primary`, `border-warning/30`, `border-transparent`… étaient
  ignorés dans toute l'application (cases à cocher, barre de phase des logs, onglets).
