---
section: 🐛 Corrections
---

- **Mode Arena : chaque réponse porte le nom du modèle qui l'a écrite.** Les cartes et l'historique affichent le modèle et son fournisseur au lieu de « Modèle A » / « Modèle B ». Un modèle en échec s'affiche comme une erreur et ne peut plus être choisi au vote.
- **Copilot : fin de l'erreur « Copilot token exchange failed (403) ».** Quand GitHub refuse l'échange de jeton interne (cas du jeton de GitHub CLI), WorkPilot utilise directement le jeton GitHub auprès de l'API Copilot, comme pour les comptes d'organisation. Une erreur d'un fournisseur n'est plus jamais rendue comme la réponse du modèle.
