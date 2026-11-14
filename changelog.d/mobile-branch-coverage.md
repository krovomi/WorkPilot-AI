---
section: 🧪 Filets de test
---

- **L'app mobile est couverte à 100 % sur les branches aussi** : chaque écran est testé quand une lecture ou une écriture échoue et quand les données sont plus maigres que d'habitude, et le plancher Jest passe à 100 % partout. Les replis impossibles ont été retirés plutôt que testés (une action de carte non indexée passe par `runPhase`, un bandeau d'erreur reçoit l'erreur elle-même).
