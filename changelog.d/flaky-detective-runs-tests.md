---
section: 🐛 Corrections
---

- **Le détective de tests instables exécute maintenant les tests lui-même.** La page ne lisait que des rapports déjà présents sur le disque : la plupart des projets n'en gardent pas (`dotnet test` n'en écrit aucun sans `--logger trx`), d'où « 0 instables sur 0 tests » et un message en anglais. Elle détecte la commande de test du projet (.NET, pytest, Vitest, Jest avec jest-junit, Maven, Gradle, Go), l'exécute le nombre de fois choisi avec la sortie TRX ou JUnit, montre chaque exécution pendant qu'elle tourne, et garde les rapports dans `.workpilot/flaky-tests/` pour les analyses suivantes. Un projet serveur exécute ses tests sur le serveur. Une annulation arrête tout l'arbre de processus (hôte de tests `dotnet` compris), une erreur de compilation s'affiche avec la sortie de l'outil, les tests qui échouent à chaque exécution sont listés à part, et tous les textes (causes, corrections suggérées, état vide) sont traduits en français et en anglais.
