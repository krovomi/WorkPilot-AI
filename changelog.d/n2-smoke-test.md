---
section: 🧪 Filets de test
---

- **L'app est démarrée avant d'être publiée** (F120). La CI lance le build sur les trois
  OS et la release chaque app packagée avant l'envoi ; l'app doit monter son interface,
  sinon le job échoue. La 1.3.1, qui ne démarrait pas, n'aurait pas pu sortir.
