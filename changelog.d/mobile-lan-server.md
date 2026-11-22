---
section: 🐛 Corrections
---

- **L'app mobile joint un serveur du réseau local** : l'adresse peut être le nom de la machine
  (`http://build-box`), plus seulement son IP, et l'APK Android accepte enfin le http simple
  vers le réseau local (une version de release le refusait, même vers une IP). iOS reçoit la même
  règle (`NSAllowsLocalNetworking`). Le http reste refusé vers toute adresse publique ou tout nom
  avec domaine.
