---
section: 🐛 Corrections
---

- **Les dates suivent la langue de l'application.** En français, elles s'écrivent à la française
  (`02/11/2026 16:30`, `2 nov. 2026`) ; en anglais, au format américain (`11/2/2026, 4:30 PM`,
  `Nov 2, 2026`), quelle que soit la région de Windows, macOS ou du téléphone. Avant, la plupart
  des écrans suivaient la région du système et certains (issues et merge requests GitHub/GitLab,
  journaux de PR, analyse concurrentielle) étaient figés en anglais. Le menu de restauration des
  terminaux affiche aussi « Aujourd'hui » / « Hier » en français.
