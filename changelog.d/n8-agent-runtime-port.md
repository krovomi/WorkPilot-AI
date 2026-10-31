---
section: 🛠️ Qualité
---

- **Le cycle d'imports des agents recule à 20 unités** (F131). Le résolveur de conflits de
  merge, le client Linear, l'extracteur d'insights et le relecteur d'architecture lancent leur
  session par un port, `agent_runtime`, que `core` installe, au lieu d'importer `core` ou
  `agents`. Aucun client en plus : chaque appel va aux mêmes fabriques, avec les mêmes hooks et
  les mêmes droits d'outils.
