---
section: 🐛 Corrections
---

- **Un compte Claude déconnecté met la tâche en pause « reconnexion » au lieu de faire échouer la planification.** Le CLI Claude répond à un jeton expiré ou révoqué par un message (« Failed to authenticate. API Error: 401 … »), pas par une erreur : il était lu comme un plan sans `phases`, et trois de suite donnaient « the model did not produce a valid implementation_plan.json ». La session le traite maintenant comme une erreur d'authentification, quel que soit le fournisseur (réponse du modèle, ou seule ligne d'état d'un tour vide), ce qui déclenche aussi la bascule automatique vers le compte suivant.
- **Une phase de skill qui échoue n'écrit plus son erreur comme rapport.** Le texte d'erreur d'un `brainstorm` n'est plus transmis au planificateur comme les conclusions de la phase, et un rapport laissé par un essai précédent est retiré.
- **La reprise de conversation ne regonfle plus à chaque nouvel essai.** Le prompt de session précédé de la ligne `EFFORT:` n'était pas reconnu, donc chaque essai rejouait tous les prompts d'avant (de 5 000 à 168 000 caractères en six essais).
- **Quand la planification échoue sur une réponse courte, la carte cite cette réponse** (refus du modèle, erreur renvoyée en texte) au lieu du seul message sur le format du plan.
