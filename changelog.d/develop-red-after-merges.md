---
section: 🧪 Filets de test
---

- **CI** : la mesure de couverture n'écrit plus d'avertissement dans la sortie des runners lancés
  par les tests (la CI demandait un moteur de mesure incompatible avec le suivi des greenlets).
- **Tests sous Windows et macOS** : les tests de l'émulateur d'app tiennent compte des aides que
  Windows lance (libérer le port, arrêter un serveur) ; le clone par la forge simulée reçoit les
  variables sans lesquelles Windows ne lance pas git ; le nom de spec refusé est un nom qu'un
  dossier Windows peut porter ; les petites apps de `verify` écoutent sans attendre la résolution
  du nom de la machine.
