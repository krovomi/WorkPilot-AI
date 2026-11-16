---
section: 🐛 Corrections
---

- **Carte d'architecture** : un projet rangé sous un dossier nommé `build`, `dist` ou `.venv`
  n'est plus lu comme vide ; seuls les dossiers de ce nom *dans* le projet sont écartés.
- **Carte d'architecture** : un `package.json`, un `pyproject.toml` ou un `requirements.txt` d'une
  autre forme (dépendances en liste, texte qui n'est pas de l'UTF-8) se lit comme « sans
  dépendance » au lieu d'interrompre la collecte.
- **Carte d'architecture** : un composant qui cite un fichier d'un dossier caché (`.github/`,
  `.tools/`) garde sa source à l'épinglage et compte quand ce fichier change ; un changement sous
  `.workpilot/` ou `.venv/` n'est plus pris pour un changement d'architecture.
- **Carte d'architecture** : un modèle dont `meta` ou `components` n'a pas la forme attendue va
  jusqu'à la validation d'archify, qui dit quoi corriger, au lieu d'arrêter la génération ; un
  modèle illisible (dossier, texte qui n'est pas de l'UTF-8) est signalé comme tel.
- **Onglet Delta** : un `delta.status.json` retouché à la main, dont un champ a une autre forme,
  s'affiche sans erreur.
- **Cerveau partagé** : l'échec d'un clone n'est plus classé « authentification » parce que le
  chemin ou l'URL qu'il cite contient `403` ou `permission denied`.
- **Mémoire partagée** : l'avis d'un modèle sur deux notes en conflit est lu même quand le modèle
  ajoute des accolades après sa réponse, et une entrée de la file d'une autre forme est refusée
  proprement.
- **Mémoire partagée** : une file de conflits retouchée à la main (un côté qui n'est pas un objet)
  ne fait plus échouer son affichage ni sa résolution, et une note dont `agents` ou `tasks` est
  écrit comme un seul texte n'est plus lue lettre par lettre.
- **Journal de la mémoire** : une ligne fusionnée d'un autre poste dont `related` est un texte ne
  le lit plus lettre par lettre, et plusieurs lignes sans identifiant ne se réduisent plus à la
  première.
