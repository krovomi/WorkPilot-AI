---
section: 🧪 Filets de test
---

- **Tests sous Windows et macOS** : les tests de l'émulateur d'app tiennent compte des aides que
  Windows lance (libérer le port, arrêter un serveur) ; le clone par la forge simulée reçoit les
  variables sans lesquelles Windows ne lance pas git ; le nom de spec refusé est un nom qu'un
  dossier Windows peut porter ; les petites apps de `verify` écoutent sans attendre la résolution
  du nom de la machine, et le journal lu par la boîte à outils de `verify` est écrit octet pour
  octet.
