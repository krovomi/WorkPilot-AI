---
section: 🧪 Filets de test
---

- **Couverture backend, lot B2 (agents)** : le paquet `agents/` passe de 72 % à 94 % sur les tests qui le touchent, avec des modèles remplacés seulement à la frontière (fabrique de clients, session) et de vrais fichiers, dépôts git et sous-processus partout ailleurs.
  - À 100 % : le remplisseur de modèle de PR, l'exécuteur de vagues et l'analyseur de dépendances du swarm, l'analyse d'impact, le débogueur persistant et sa porte pour les providers hors SDK, le marqueur de hot swap, le parseur de reprise après rate limit, les outils WorkPilot de mémoire et de progression, les helpers git et de synchronisation de spec, l'enregistrement des sessions pour Replay et Debugger.
  - Plus couverts : la boucle de session SDK (52 → 84 %), le coder (70 → 86 %), le planificateur de suivi, la mémoire de session dans le vault, le documenteur et le refactoreur (99 %), le câblage optionnel (routeur de modèles, contexte cognitif, agents de domaine).
  - Code mort retiré, preuves à l'appui : le registre du débogueur en mémoire, les replis `ImportError` vers des paquets qui sont toujours livrés, l'alias `sync_plan_to_source`, `SwarmConfig.from_dict`, `SubtaskNode.all_files` et des `except` qui ne pouvaient pas se déclencher.
- 🐛 **Un sous-agent du swarm ne tient plus la vague au-delà de son délai** : le délai couvrait la lecture de la sortie mais pas la fin du processus. Une ligne de sortie de plus de 64 Ko ne fait plus échouer la sous-tâche (« Separator is not found »).
- 🐛 **Le swarm respecte son nombre de nouvelles tentatives**, et une sous-tâche réussie au second essai compte comme réussie : la vague est fusionnée avec elle au lieu d'être déclarée en échec.
- 🐛 **Un plan dont toutes les sous-tâches sont déjà faites termine le swarm** au lieu d'échouer sur une `KeyError` dans ses statistiques.
- 🐛 **Le coder répond à l'agent qui demande s'il doit bloquer une vérification manuelle** : la question était cherchée avec une majuscule dans sa réponse mise en minuscules, donc jamais trouvée.
