---
section: ✨ Nouveautés
---

- **Onglet Captures dans la tâche** : l'onglet « Preuves visuelles » devient « Captures ». Il montre chaque écran que la tâche a préparé pour sa PR, avant et après, tel que la PR le montre (données personnelles déjà remplacées par des fausses), dit où elles en sont (dans la PR, en attente de « Publier », gardées sur la tâche, retenues) et ce qui a été remplacé. Les boutons « Publier dans la PR », « Retirer de la PR » et « Mettre à jour la PR » passent par le backend, qui ne modifie que la PR de la branche de la tâche. Une tâche sans captures montre sa preuve visuelle comme avant. Chaque carte peut dire « toujours » ou « jamais » pour elle-même.
- **Appareil photo sur la carte du Kanban** : une carte dont la tâche a des captures porte une pastille avec leur nombre et leur état ; l'aperçu au survol montre le premier écran.
- **Réglages des captures** : Paramètres › Projet › Captures des PR règle quand prendre des captures, l'« avant » sur la branche de base, le remplacement des données personnelles, les sélecteurs privés en plus, la publication (automatique, après relecture, jamais), la durée de conservation et la branche des images.
- **La preuve visuelle laisse la place aux captures** : quand la tâche a des captures, la preuve visuelle ne relance plus l'app à la création de la PR, ne committe plus d'images sur la branche de la tâche et ne poste plus son commentaire.
