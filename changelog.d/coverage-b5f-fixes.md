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
