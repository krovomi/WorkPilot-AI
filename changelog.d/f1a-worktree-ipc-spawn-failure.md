---
section: 🐛 Corrections
---

- **Fusion, aperçu de fusion, analyse d'impact et création de PR répondent par une erreur lisible quand le backend ne peut pas démarrer** : si le lancement de Python échouait d'emblée, l'appel IPC était rejeté et la fenêtre recevait une exception brute au lieu du message « échec » attendu.
- **La détection des IDE et terminaux écarte de nouveau un chemin qui remonte d'un dossier après expansion** (`%USERNAME%`, `~`) : le contrôle normalisait le chemin avant de chercher `..`, qui disparaissait donc toujours sous Windows et après un préfixe absolu.
