---
section: 🧪 Filets de test
---

- **Couverture backend, lot B3d (fin de `security/`)** : les guardrails (lecture des règles, politique par couches, journal et approbations, analyse des manifestes de dépendances), la garde des résultats d'outils, l'analyseur de commandes et la garde de la configuration de sécurité passent à 100 %. Les cas limites sont testés pour de vrai : fichiers illisibles, disque qui refuse l'écriture, approbation expirée ou impossible à marquer, page énorme échantillonnée, analyseur qui lève une exception.
- **Garde de la configuration de sécurité** : un `bash -c` imbriqué dans un autre est désormais lu comme le lit le shell. Les guillemets du script intérieur étaient coupés, la ligne n'était plus analysable et seule la recherche du nom de fichier s'appliquait. La limite de profondeur des `bash -c` imbriqués s'applique de nouveau.
- **Code mort retiré** : `security/secure_subprocess.py` (aucun appelant), `load_guardrails`, `GuardrailDecision.should_block`, `guardrail_semantics.is_manifest` (la garde des dépendances a la sienne) et deux branches inaccessibles de l'analyseur de commandes.
