---
section: ✨ Nouveautés
---

- **Enregistreur du Browser Agent, lot 2** (#387) : une session s'exporte aussi en test Selenium (Python, Java) ou WebdriverIO, et l'enregistreur suit les iframes et les shadow roots ouverts, que chaque export traverse. Le test attend ce que chaque action a provoqué (la page où elle mène, la requête qu'elle lance, l'élément qui apparaît) au lieu de marquer des pauses, et chaque valeur enregistrée est écrite comme un littéral de la langue cible, guillemets, antislashs, retours à la ligne et `${}` compris.
