---
section: 🐛 Corrections
---

- **Applications mobiles (Android)** : un SDK Android installé à l'emplacement par défaut
  d'Android Studio est trouvé sans `ANDROID_HOME` ; les dossiers par défaut de chaque système
  n'étaient jamais consultés.
- **Applications mobiles** : un `package.json` d'une autre forme (liste, dépendances écrites
  comme une liste) ne fait plus manquer la détection d'une application Capacitor voisine, et une
  liste de simulateurs iOS d'une autre forme donne « aucun simulateur » au lieu d'une erreur.
