---
section: ✨ Nouveautés
---

- **Essai à blanc : le plan d'une spec est répété avant le build** (F183). La page « Aperçu des changements » devient « Essai à blanc », avec un onglet « Répétition du plan » : chaque sous-tâche est rejouée sur les fichiers de la branche de base, sans rien écrire ni appeler de modèle. Elle signale un fichier modifié avant d'être créé ou absent de la branche, un chemin hors du projet, deux sous-tâches parallèles sur le même fichier, une vérification qui ne peut pas tourner (`dotnet test` sans projet, `cargo` sans `Cargo.toml`, script npm absent…), et répond aux vérifications d'API par un mock tiré du contrat OpenAPI du dépôt. Le rapport donne un verdict, l'empreinte prévue en fichiers et l'estimation du coût du vrai build. L'aperçu des changements non commités reste le second onglet (#373).
