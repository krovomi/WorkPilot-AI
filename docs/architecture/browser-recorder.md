---
feature: Enregistreur du Browser Agent
summary: >-
  Une session pilotée à la main devient un test Playwright (TS, Python) ou Cypress : étapes
  typées et bornées, sélecteurs robustes, secrets en variables d'environnement, texte de la
  page en littéral échappé, test proposé sur une carte de revue ou dans un fichier hors projet.
---

# Enregistreur du Browser Agent : une session devient un test

> Pourquoi l'onglet « Enregistreur » du Browser Agent enregistre ce que fait une personne sur une
> page et l'exporte en test E2E, et comment. Issue : #387 (lot 1). Règles :
> [`security.md`](../rules/security.md) (S1, S2, S4, S6, S7) ; écriture dans un projet :
> [generated-review.md](generated-review.md).

## Le constat

Le Browser Agent ouvrait une page (Playwright, sans fenêtre) pour la capturer, comparer ses écrans
et lancer les tests E2E du projet. Il n'avait ni enregistreur, ni générateur de sélecteurs, ni
export : un test E2E s'écrivait à la main. L'issue citait Chrome DevTools MCP ; le code actuel
pilote Chromium par Playwright (`browser_agent/browser_controller.py`), c'est donc sur lui que
l'enregistreur est posé, avec une fenêtre cette fois.

## Le mécanisme

1. **La session** (`runners/browser_recorder_runner.py record`). Le main lance le runner avec
   l'environnement statique (`pythonStaticRunnerEnv` : ni provider, ni clé, ni profil Claude ;
   aucun modèle n'est appelé et la page est le code d'un autre). Le runner ouvre l'adresse dans
   une fenêtre de `BrowserController(headless=False)` et s'arrête sur la ligne `stop` que le main
   écrit sur son stdin (bouton « Arrêter »), ou quand la personne ferme la fenêtre.
2. **Ce que la page rapporte** (`browser_agent/recorder_script.js`, script d'init de chaque
   frame, liaison `__workpilotRecord`) : clic, saisie, choix dans une liste, Entrée ou Échap, et
   Alt+clic, qui vérifie le texte visible de l'élément au lieu de cliquer. Le script décrit
   l'élément (test id, rôle et nom accessible, label, placeholder, texte, id et `name` avec leur
   unicité, chemin CSS court) ; il n'envoie jamais la valeur d'un champ mot de passe ou nommé
   comme un secret.
3. **Les étapes** (`browser_agent/recorder.py`, `recording.py`). Un rapport est une donnée de la
   page : listes fermées (`STEP_KINDS`, `STRATEGIES`, `ROLES`, `KEYS`), chaque chaîne bornée, au
   plus 300 étapes (au-delà, la session le dit). Seul le cadre principal compte. Les saisies
   successives d'un même champ font une étape, mise à jour en place. Une navigation n'est une
   étape que si aucune action ne l'a causée dans les 2,5 s (un lien, un formulaire) : rejouer
   l'action rejoue la navigation.
4. **Les sélecteurs** (`browser_agent/selector_builder.py`), dans l'ordre des guides Playwright
   et Testing Library : `data-testid` unique (ou `data-test`, `data-cy`, `data-qa`), rôle ARIA et
   nom accessible, label, placeholder, texte visible (pas pour un champ), puis CSS court : id
   stable unique, `name` unique, chemin. Un id qui ressemble à une génération (`btn-a1b2c3`,
   `:r1:`, `ember123`) n'est jamais pris.
5. **Les secrets.** Une valeur saisie dans un champ `password`, un champ dont le nom, l'id, le
   label ou l'autocomplete nomme un secret, ou une valeur qui a la forme d'une clé
   (`foundation/log_redaction.redact_text`) n'est jamais gardée : l'étape porte le nom d'une
   variable (`E2E_PASSWORD`, `[A-Z0-9_]` seulement) que le test lit. Un texte à vérifier qui
   contient une clé n'est pas enregistré, une URL qui en porte une perd sa query.
6. **Le main garde les étapes** (`main/browser-recorder/recorder-session.ts`), relues par
   `parseRecordedStep`. Le renderer les affiche, en retire, et n'envoie à l'export que des ids :
   il ne fournit jamais le contenu d'une étape.
7. **L'export** (`browser_agent/codegen.py`, `runner export`, `main/browser-recorder/recorder-export.ts`) :
   Playwright TypeScript (`e2e/*.spec.ts`), Playwright Python (`tests/e2e/test_*.py`) ou Cypress
   (`cypress/e2e/*.cy.js`), dans le dossier de tests que le projet a déjà quand il en a un. Tout
   texte de la page entre dans le code par `literal()` (JSON, non-ASCII échappé) : un littéral
   valide en JS, TS et Python, sans gabarit ni interpolation ; Cypress `type` reçoit
   `parseSpecialCharSequences: false`. Aucun texte de page dans un commentaire. Cypress n'a pas de
   requête par rôle ou label : il prend le sélecteur suivant qu'il sait écrire, et une étape sans
   sélecteur exprimable reste un commentaire `// step skipped`.
8. **Les destinations** : « Aperçu » (rien n'est écrit) ; « Proposer sur une carte de revue »
   (`openReviewRun(…, "browser-recorder", …)` : le fichier va dans le worktree de la carte, sur
   sa branche, commit `test(e2e): add recorded test <nom>`) ; « Enregistrer dans un fichier… »
   (boîte native ouverte sur Téléchargements ; un chemin dans un projet de cet ordinateur est
   refusé : c'est le rôle de la carte). Jamais dans le dossier du projet.

## Frontières

- **S2** : texte, labels, URL et valeurs de la page sont des données : bornés, en listes fermées,
  écrits en littéral échappé. Une page peut appeler la liaison elle-même et inventer des étapes ;
  elles restent des données que la personne relit dans la liste et dans le diff de la carte.
- **S6** : l'adresse (http(s) seulement, 2 048 caractères), le format et la destination (listes
  fermées) et les ids d'étapes sont relus dans le main ; le dossier du projet passe par
  `DIRECTORY_ARGS`. Le nom du test et l'adresse sont passés au runner en `--option=valeur` : une
  valeur qui commence par `-` n'est pas lue comme une option.
- **S4** : sous-processus sans shell ; le chemin proposé par le générateur est résolu dans le
  worktree et doit garder l'extension du format.
- **S7** : un projet en hors-ligne strict n'enregistre qu'une page de cet ordinateur
  (`localhost`, boucle locale).

## Pas encore fait

- Export Selenium et WebdriverIO.
- Iframes (seul le cadre principal est enregistré), Shadow DOM, `contenteditable`, liste à choix
  multiples, survols, défilements, boîtes de dialogue, glisser-déposer.
- Un sélecteur non unique de rôle ou de texte (`nth`) ; le diff des sélecteurs quand le test
  généré échoue (« reshoot »).
- Attentes déduites des transitions (spinner, requêtes réseau), assertions proposées après une
  action, nom de test et données paramétrables (email, dates) extraits en fixtures par un modèle
  léger via `create_client()`, sur tous les providers.
- Lancer le test généré depuis la page et mesurer son taux de passage au premier essai.
- Un projet du serveur (mode serveur) : la page reste locale.

Vérification : `pytest tests/browser_agent -q` ;
`cd apps/frontend && pnpm test -- browser-recorder RecorderTab`.
