---
section: 🐛 Corrections
---

- **Azure DevOps** : les fichiers modifiés d'une pull request ont de nouveau leur chemin (il
  arrivait vide), et leur ancien chemin quand ils sont renommés.
- **Contexte d'une tâche** : un projet rangé sous un dossier nommé `build`, `dist` ou `out` n'est
  plus ignoré en entier ; les imports relatifs JavaScript (`./`, `../`) et `from paquet import
  module` en Python relient enfin les fichiers ; la recherche de code lit aussi C#, Java, Kotlin,
  Go, Rust, PHP, Ruby, Swift… et nomme les fichiers `src/a.cs` sur tous les systèmes ; les
  dépendances circulaires sont rapportées dans le même ordre sur tous les systèmes.
- **Clonage d'environnement** : une image d'un registre avec port (`registry:5000/api`), les ports
  en syntaxe longue ou `127.0.0.1:8000:80`, un `docker-compose.yml` vide et la sortie JSON en
  tableau des versions récentes de Compose ne font plus échouer la capture ; sans PyYAML, les
  services sont lus quelle que soit l'indentation, sans prendre les réseaux ni les volumes.
- **Performance Profiler** : une requête, une boucle imbriquée ou une lecture bloquante n'est
  signalée que si elle est dans le bloc de la boucle ou de la fonction, et non quelques lignes plus
  bas (fini les N+1 sur un `dict.get`) ; les règles lisent aussi C#, Java, Kotlin, Go, Rust, C/C++,
  Swift, PHP ; le temps des tests est mesuré pour Go, Cargo, .NET, Maven, Gradle et Mocha, avec
  `python3` quand `python` n'existe pas ; le conseil `useCallback` est de nouveau proposé.
- **Context Mesh** : les recommandations d'un projet sont retrouvées (le modèle nomme les projets,
  la recherche se faisait par chemin) ; la pile vient du détecteur commun à toute l'app ; un projet
  se retire avec le chemin tapé ; un enregistrement illisible ne masque plus tous les autres et
  chaque fichier s'écrit de façon atomique.
