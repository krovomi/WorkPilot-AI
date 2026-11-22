---
section: ✨ Nouveautés
---

- **Enregistreur du Browser Agent, lot 5** (#387) : les valeurs saisies pendant l'enregistrement (e-mails, dates, nombres, noms…) ne sont plus écrites dans les étapes du test. Le test les lit par une clé, dans un fichier de données écrit à côté de lui (JSON pour Playwright, WebdriverIO et Selenium en Python, JavaScript et Ruby ; une fixture `cy.fixture` pour Cypress) ou dans un bloc de constantes `TestData` en Java et en C#. L'onglet montre chaque clé avec ce qu'elle contient et le fichier, que la carte de revue écrit avec le test. Les secrets restent des variables d'environnement.
