---
extends: verify
provider: ollama
---
Modèle local : la boucle déterministe (lancement, erreurs, corrections
bornées, trace, captures, rejeu des endpoints) est déjà faite par WorkPilot
avant cette session. Ce qui reste à faire ici est court — le faire **une
action à la fois**.

## Frontend

1. `verify_browser` `{"action": "navigate", "url": "<la page de la tâche>"}`.
2. `verify_browser` `{"action": "snapshot"}` — lire la liste des éléments.
3. Une seule action (`click` ou `fill`) avec un `uid` de cette liste.
4. Reprendre en 2 jusqu'à l'état attendu. Au plus douze actions.
5. `verify_record` `{"kind": "confirm", "state": "<ce que montre la page>", "evidence": "<texte ou élément vu>"}`.
6. `verify_screenshot` `{"label": "etat-confirme"}`.

Ne pas relancer la trace de performance : elle a déjà été mesurée.

## Backend

1. `verify_endpoints` — la liste des endpoints touchés, chacun avec un payload
   déjà construit depuis son schéma.
2. Pour chacun : `verify_call_endpoint` avec ce payload, **sans l'inventer** ;
   ne le modifier que pour une valeur métier que la tâche impose.
3. Comparer le code obtenu au code attendu, et le payload de retour à la
   requête. Un écart → `verify_record` `{"kind": "endpoint", ...}` avec
   `ok: false`.

## Fix & retry
<!-- append -->
Une correction à la fois, puis `verify_launch` et `verify_logs`. Si l'erreur
est la même après deux corrections, s'arrêter et la décrire.
