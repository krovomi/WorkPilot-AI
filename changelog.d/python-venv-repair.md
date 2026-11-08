---
section: 🐛 Corrections
---

- **Les pages qui lancent Python se réparent seules** (F170) : quand le Python qui avait créé l'environnement du backend a été mis à jour ou désinstallé, la Feuille de route, le Débogueur d'agent et les autres analyses échouaient avec « Python environment not ready: Unhandled error. ('Python not found in virtual environment') ». L'environnement est maintenant reconstruit automatiquement, et une vraie panne affiche sa cause. La barre des phases de la Feuille de route n'affiche plus de « ) » parasites.
