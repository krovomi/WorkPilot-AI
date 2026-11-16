---
section: 🐛 Corrections
---

- **Pièces jointes (OCR)** : une réponse d'une autre forme du modèle de vision local (liste des
  modèles, réponse) ou du service Azure se lit comme « pas de réponse » au lieu d'interrompre la
  lecture de la pièce jointe.
- **Pièces jointes** : un `requirements.json` d'une autre forme (liste, images jointes écrites
  comme un texte) ne fait plus échouer la liste des pièces jointes d'une tâche.
- **Schémas Excalidraw** : une scène dont les liaisons de flèches ou la liste d'éléments ont une
  autre forme se lit sans erreur ; seules les flèches reliées des deux côtés sont tracées.
- **Tableau blanc → draw.io** : deux boîtes que le modèle de vision donne sous le même identifiant
  ne produisent plus un fichier `.drawio` aux cellules en double (la première l'emporte), et des
  listes d'une autre forme dans sa réponse se lisent comme « rien de dessiné ».
- **Maquettes Figma** : une réponse de l'API dont les enfants d'un calque ne sont pas une liste
  n'interrompt plus l'import, et un `.figma.json` écrit à la main dont les libellés sont un texte
  au lieu d'une liste ne se lit plus lettre par lettre.
- **Captures HTTP → tests** : une collection Postman ou un fichier OpenAPI retouchés à la main
  (une liste remplacée par un texte ou un nombre) ne font plus échouer la lecture ; une ligne
  `curl` ne prend plus la valeur d'une option (`-o fichier`, `-u`, `-b`, `-A`…) pour l'URL, et
  `-u` / `-b` se lisent comme les en-têtes `Authorization` / `Cookie` qu'ils deviennent, donc
  masqués.
- **Conformité d'architecture** : un `workspaces` vide ou enraciné dans un `package.json` ne fait plus échouer la lecture du graphe de modules.
