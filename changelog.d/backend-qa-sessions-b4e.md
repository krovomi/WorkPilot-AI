---
section: 🧪 Filets de test
---

- **Couverture backend, lot B4e (QA, sessions)** : le relecteur QA et le correcteur QA suivent leur session par un seul module, `qa/session_stream.py`, à la place des deux copies qu'ils portaient chacun (environ 1 000 lignes, dont la moitié écrite pour un client que plus rien ne crée). Ce module, le relecteur, le correcteur et la boucle de correction automatique passent à 100 %, testés sur un vrai client scripté. Les faux modules du SDK que des tests de la QA laissaient dans `sys.modules` sont retirés.
- **QA, relecteur et correcteur** :
  - une session que le fournisseur termine sur une erreur (limite atteinte, connexion expirée) est rapportée comme telle. Le relecteur disait à la passe suivante qu'elle avait « oublié de mettre à jour le plan », et le correcteur répondait « corrigé » sans avoir rien touché, ce qui faisait dépenser une passe de relecture sur le même code ;
  - la carte Historique des sessions d'une passe QA nomme son fournisseur et son modèle, et une session qui plante y finit en échec.
- **QA, correction automatique (`--auto-fix`)** :
  - les échecs de pytest sont comptés : pytest les écrit avant les réussites (`2 failed, 5 passed`), et la demande de correction en annonçait 0 ;
  - une suite qui écrit dans un autre encodage que l'UTF-8 (console Windows) garde sa sortie, qui était perdue et remplacée par « Test execution failed » ;
  - chaque passe qui a corrigé ou échoué est enregistrée dans la mémoire du projet. L'appel ne correspondait pas à la fonction de mémoire et aucune n'avait jamais été enregistrée ;
  - une limite de débit atteinte pendant la session du correcteur est attendue au lieu de coûter une tentative ;
  - le rapport d'escalade compte toutes les tentatives et montre la sortie de la dernière, les motifs d'échec fréquents remplissent les statistiques, et la sortie des tests recopiée dans la demande de correction est bornée à sa fin.
