---
section: 🐛 Corrections
---

- **Une sous-tâche bloquée dit pourquoi et se débloque depuis son panneau.** Sous chaque sous-tâche bloquée (ou échouée), l'onglet Sous-tâches affiche la raison, ce qu'il faut faire, et quatre réponses : « C'est fait », « Réessayer », « Répondre à l'agent » (la réponse arrive dans le prompt du codeur et la tâche redémarre) et « Pas nécessaire ». Ça marche pour une tâche locale comme pour une carte du serveur, sur tous les providers.
- **Une vérification que l'agent peut faire lui-même n'est plus bloquée.** Le prompt du codeur ordonnait de bloquer toute vérification qui n'était pas une commande, un appel d'API, un contrôle navigateur ou un scénario E2E (y compris `none`), avec une raison écrite dans un champ que l'app ne lisait pas : « Vérifier que test.txt contient 'OK' » finissait « Bloquée — intervention manuelle requise ». L'agent lance maintenant la vérification avec ses outils, quel que soit le langage, et ne bloque que ce qui demande vraiment une personne, avec une raison lisible. La boucle ne transforme plus en blocage une vérification manuelle que l'agent a terminée.
