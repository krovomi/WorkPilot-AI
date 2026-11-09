---
section: 🐛 Corrections
---

- **La release se construit enfin sur le tag** (F184). `pnpm run package:linux -- --publish never` transmettait un `--` littéral avant `--publish never` ; electron-builder s'arrêtait à ce `--`, ignorait l'option et tentait de publier lui-même avec le jeton en lecture seule du job. Les builds du tag de 1.4.0 et 1.4.1 échouaient ainsi sur un 403 sur les quatre plateformes, et chaque version devait être relancée à la main. Le script de packaging retire ce `--`, et un test vérifie ce que reçoit vraiment electron-builder.
