---
section: 🧪 Filets de test
---

- **Tests sous Windows et macOS** : les tests de l'émulateur d'app tiennent compte des aides que
  Windows lance (libérer le port, arrêter un serveur) ; le clone par la forge simulée reçoit les
  variables sans lesquelles Windows ne lance pas git ; le nom de spec refusé est un nom qu'un
  dossier Windows peut porter ; les petites apps de `verify` écoutent sans attendre la résolution
  du nom de la machine, et le journal lu par la boîte à outils de `verify` est écrit octet pour
  octet.
- **Tests qui dépendaient de l'ordre** : le nettoyage des modules factices remet le vrai module
  que son paquet tient encore, au lieu d'en laisser charger une seconde copie ; la création de MR
  GitLab remplace l'analyse d'impact par un double, au lieu de lancer un vrai modèle quand un
  jeton se trouve dans l'environnement ; les tests des critères QA lisent l'état de build simulé
  même quand un autre fichier a importé `qa.criteria` avant eux.
