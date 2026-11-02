---
section: 🐛 Corrections
---

- **La PR d'une carte du serveur reprend ce que tu as retouché dans le dialogue.** En mode serveur, « Créer la PR » ne transmettait que la demande : le titre, le corps, la branche cible et l'option brouillon modifiés dans le dialogue étaient perdus, et le serveur écrivait les siens depuis la spec. Ils partent maintenant avec le run, vérifiés par le serveur (titre d'une ligne, branche au nom sûr, corps borné et passé par un fichier).
