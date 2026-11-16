---
section: 🐛 Corrections
---

- **Terminaux et profils Claude** : les handlers des terminaux, de leurs sessions, des profils Claude, de la bascule automatique et de l'usage revérifient ce que le renderer envoie avant de l'utiliser (`terminal/terminal-ipc-guard.ts`) : identifiants et noms bornés, tailles entières, jour au format `AAAA-MM-JJ`, réglages de bascule limités à leurs champs. Un nouveau terminal ne reçoit du renderer qu'une variable d'environnement, le dossier `CLAUDE_CONFIG_DIR` d'un profil sous le dossier personnel. Relancer après une limite de débit ne change plus de profil pour un projet inconnu et signale un profil introuvable. Les canaux que l'UI n'appelait pas sont supprimés : effacer les sessions d'un projet, reprendre Claude dans un terminal par son canal, demander l'usage par `/usage` et lire le meilleur profil disponible. Le test des dossiers reçus par l'IPC lit aussi les handlers enregistrés sur un `ipcMain` gardé.
