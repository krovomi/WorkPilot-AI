---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F2d (émulateur d'application)** : le service qui reconnaît un projet et lance son serveur de développement passe de 32 % à 98 % des instructions, et ses handlers IPC de 0 % à 100 %. Les tests créent de vrais dossiers de projet (Node, Python, Go, Rust, Docker, .NET récent et ancien, projets fullstack, dossiers de travail WorkPilot), font tourner de vrais serveurs HTTP sur de vrais ports, et ne simulent que les processus lancés et le système d'exploitation.
- **API .NET rangée dans un sous-dossier** : dans un projet fullstack dont l'API .NET est dans `backend/Api/`, `dotnet run` partait de `backend/`, où aucun projet ne se trouve. Il part du dossier du projet .NET.
- **Arrêt pendant le démarrage** : arrêter l'émulateur pendant l'installation des dépendances ou l'attente du port laissait le serveur démarrer quand même, sans plus pouvoir l'arrêter depuis l'app. Un arrêt annule maintenant le démarrage en cours.
- **Ancien serveur qui se termine en retard** : quand le processus d'un serveur arrêté ou remplacé se terminait après coup (taskkill sous Windows), l'app affichait « arrêté » ou une erreur pour le serveur qui tournait, et perdait la trace d'un service fullstack relancé. Seule la fin du processus en cours compte.
- **Services fullstack** : chaque processus n'est tué qu'une fois à l'arrêt, et une configuration sans service principal ne lance plus le premier service deux fois sur le même port.
- Code jamais exécuté retiré : le nettoyage de jonctions Windows que rien ne créait, une seconde vérification du runner Python, une borne de profondeur que la récursion n'atteint jamais.
