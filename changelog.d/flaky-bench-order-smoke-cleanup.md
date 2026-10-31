---
section: 🧪 Filets de test
---

- **Deux tests qui échouaient au hasard en CI ne le font plus**. Le test du banc de rejeu datait
  ses cartes l'une après l'autre : sur Windows, l'horloge avançait d'une milliseconde entre deux
  cartes et l'ordre attendu s'inversait ; les cartes partagent maintenant le même instant, et un
  nouveau test vérifie que la carte terminée la plus récente vient en tête. Le smoke test
  d'Electron réessaie la suppression de son profil temporaire et n'en fait plus dépendre son
  verdict.
