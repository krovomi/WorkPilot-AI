---
section: 🛠️ Qualité
---

- **Les PR empilées se fusionnent seules, dans l'ordre.** Une PR vers `develop` avec l'auto-merge
  activé attend celles sur lesquelles elle est construite ; le pilote de pile fusionne ensuite
  `develop` dedans, résout les conflits (Claude Code pour ceux qu'une règle ne tranche pas) et ne la
  fusionne qu'une fois tous ses checks verts, alors que l'auto-merge GitHub fusionnait dès la fin
  des conflits, sans attendre la CI.
