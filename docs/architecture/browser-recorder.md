---
feature: Enregistreur du Browser Agent
summary: >-
  Une session pilotée à la main (survols, défilements, glisser-déposer, dialogues répondus dans
  l'app) devient un test Playwright, Cypress, Selenium (Python, Java, C#, Ruby, JS) ou
  WebdriverIO : étapes bornées, sélecteurs robustes, attentes déduites, secrets en variables,
  valeurs saisies en données, texte de page en littéral, test sur une carte de revue, lancé là.
---

# Enregistreur du Browser Agent : une session devient un test

> Pourquoi l'onglet « Enregistreur » du Browser Agent enregistre ce que fait une personne sur une
> page et l'exporte en test E2E, et comment. Issue : #387 (lots 1 à 5). Règles :
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
   Alt+clic, qui vérifie le texte visible de l'élément au lieu de cliquer. S'y ajoutent : le
   texte d'un `contenteditable` (une étape `fill`, son texte n'entre pas dans le nom de
   l'élément) ; les options d'une liste à choix multiples (`values`, de 2 à 20) ; un survol qui
   révèle quelque chose (une règle CSS `:hover` de la page ou une mutation près de l'élément en
   400 ms) ; un défilement voulu (molette, toucher, touches, barre) de la fenêtre ou d'une boîte,
   rapporté au repos (500 ms) ; un glisser-déposer HTML5 (`dragstart` → `drop`) ou au pointeur
   (plus de 16 px, cible sous le pointeur, dans la même racine). Le script décrit
   l'élément (test id, rôle et nom accessible, label, placeholder, texte, id et `name` avec leur
   unicité, chemin CSS court) ; il n'envoie jamais la valeur d'un champ mot de passe ou nommé
   comme un secret. L'élément est celui de `composedPath()[0]` : dans un shadow root ouvert, il
   est décrit dans sa racine (unicité et chemin comptés là) avec la liste des hôtes au-dessus
   (`shadow`) ; `change` ne sortant pas d'un shadow root, le script écoute aussi chaque racine
   ouverte que la page attache, et chaque shadow root déclaratif (`<template shadowrootmode>`)
   qu'un événement composé traverse. Un `MutationObserver` note les éléments insérés après la
   dernière action : un rapport sur l'un d'eux porte `appeared`. Le script compte aussi, dans la
   racine de l'élément, combien d'éléments ont le même rôle et nom, label, placeholder ou texte
   (`matches` : nombre et place, au plus 3 000 candidats parcourus, sinon rien n'est envoyé).
   Après une action, il note ce qu'elle a changé : un statut, une alerte, une région `aria-live`,
   un dialogue ou un titre apparu ou modifié devient une proposition (`suggest`) au bout d'une
   seconde ; un indicateur de chargement inséré (`progressbar`, `aria-busy`, classe `spin`,
   `load`, `skeleton`) qui s'est montré puis a disparu est rapporté (`settled`) par ce qu'il a
   (test id, id, rôle, `aria-busy`, classe), jamais par un sélecteur de la page ; un indicateur
   déjà présent qu'une classe, `hidden`, `style` ou `aria-busy` montre puis cache l'est aussi. Sur la page où
   une action a mené, le titre principal et les alertes sont proposés de même.
3. **Les étapes** (`browser_agent/recorder.py`, `recording.py`). Un rapport est une donnée de la
   page : listes fermées (`STEP_KINDS`, `STRATEGIES`, `ROLES`, `KEYS`), chaque chaîne bornée, au
   plus 300 étapes (au-delà, la session le dit). Les saisies successives d'un même champ font
   une étape, mise à jour en place. Une navigation n'est une étape que si aucune action ne l'a
   causée dans les 2,5 s (un lien, un formulaire) : rejouer l'action rejoue la navigation.
   - **Où vit l'élément.** Un rapport d'une iframe arrive avec sa frame Playwright : Python
     remonte les parents jusqu'au cadre principal et, pour chacun, demande au cadre parent de
     décrire l'élément `<iframe>` (`frame_element()`, puis `__workpilotDescribe`, même hors
     origine). Chaque iframe et chaque hôte shadow devient **un** sélecteur CSS
     (`selector_builder.css_selector` : test id, id stable, `name`, chemin), parce que WebDriver
     n'entre dans un cadre ou un shadow root que par CSS. Une iframe dans des shadow roots ouverts
     garde leurs hôtes (`frameShadow`, une liste par cadre). Au-delà de 8 niveaux, l'action
     n'est pas enregistrée plutôt que mal située.
   - **Les dialogues.** `page.on("dialog")` (sans écouteur, Playwright les ferme lui-même) : le
     runner demande à l'app (`RECORDER_DIALOG:{id,type,message,defaultValue}`), la personne
     répond dans l'onglet, le main n'écrit la réponse (`dialog {"id","accept","text"}`) sur le
     stdin du runner que pour l'id du dialogue en attente. Sans réponse en 5 min, le dialogue est
     fermé. La réponse reste sur l'action qui l'a ouvert (moins de 5 s avant, une par action) et
     l'export la rejoue ; un message ou un texte saisi qui a la forme d'une clé n'est pas gardé.
   - **Survols et défilements** : un survol répété du même élément reste une étape ; les
     défilements successifs d'une même cible n'en font qu'une, à la position finale (entiers de
     0 à 10 000 000). Une boîte défilée n'est jamais trouvée par son texte (c'est toute sa liste).
     Les rapports sont traités un par un, dans l'ordre (un verrou) ; la description d'une frame
     est gardée jusqu'à son détachement.
   - **Ce que l'action a causé** (les attentes, jamais une pause) : la page où elle a mené
     (`waitUrl`, sans query ni fragment) ; la première requête `fetch` ou XHR de même origine
     partie dans la seconde qui suit (`waitRequest` : méthode en liste fermée et chemin
     seulement, jamais la query, jamais un chemin qui porte une clé) ; un élément apparu après
     l'action précédente (`waitVisible`) ; un indicateur de chargement disparu dans les 15 s, dans
     la page principale (`waitHidden`). Son sélecteur est construit en Python
     (`recorder.loader_css`) à partir de cinq formes seulement (`[data-testid="…"]`, id stable,
     `[role="progressbar"]`, `[aria-busy="true"]`, une classe qui dit `spin`, `load`,
     `skeleton` ou `progress`), jamais d'un chemin CSS : une fois l'indicateur parti, un chemin
     désignerait ce qui a pris sa place.
   - **Les vérifications proposées** : un rapport `suggest` reçu moins de 5 s après une action
     devient une étape `assert_text` dont `after` nomme cette action, au plus 3 par action et
     100 par session ; un texte qui contient une clé est écarté. Elle n'entre pas dans
     l'enregistrement : le runner l'émet, le main la garde à part, et la personne la garde
     (elle se place juste après son action) ou l'écarte. Aucun modèle n'est appelé.
4. **Les sélecteurs** (`browser_agent/selector_builder.py`), dans l'ordre des guides Playwright
   et Testing Library : `data-testid` unique (ou `data-test`, `data-cy`, `data-qa`), rôle ARIA et
   nom accessible, label, placeholder, texte visible (pas pour un champ), puis CSS court : id
   stable unique, `name` unique, chemin. Un id qui ressemble à une génération (`btn-a1b2c3`,
   `:r1:`, `ember123`) n'est jamais pris. Un rôle, un label, un placeholder ou un texte que
   le script a compté sur plusieurs éléments garde la place de l'élément (`nth`, dans l'ordre
   du document) et passe après les CSS stables, avant le chemin CSS : un rejeu ne doit pas
   agir par hasard sur le premier de trois boutons « Ajouter » (Playwright refuserait même,
   en mode strict). Au-delà de 20 correspondances, ou à 0, il n'est pas gardé ; sans compte
   (page trop grande), l'ordre reste celui du lot 1.
5. **Les secrets.** Une valeur saisie dans un champ `password`, un champ dont le nom, l'id, le
   label ou l'autocomplete nomme un secret, ou une valeur qui a la forme d'une clé
   (`foundation/log_redaction.redact_text`) n'est jamais gardée : l'étape porte le nom d'une
   variable (`E2E_PASSWORD`, `[A-Z0-9_]` seulement) que le test lit. Un texte à vérifier qui
   contient une clé n'est pas enregistré, une URL qui en porte une perd sa query.
6. **Le main garde les étapes** (`main/browser-recorder/recorder-session.ts`), relues par
   `parseRecordedStep`. Le renderer les affiche, en retire, et n'envoie à l'export que des ids :
   il ne fournit jamais le contenu d'une étape.
7. **L'export** (`browser_agent/codegen.py`, `codegen_webdriver.py`, `runner export`,
   `main/browser-recorder/recorder-export.ts`) : Playwright TypeScript (`e2e/*.spec.ts`),
   Playwright Python (`tests/e2e/test_*.py`), Cypress (`cypress/e2e/*.cy.js`), Selenium Python
   avec pytest (`tests/e2e/test_*.py`), Selenium Java avec JUnit 5
   (`src/test/java/e2e/*Test.java`, `package e2e`) ou WebdriverIO avec Mocha
   (`test/specs/*.e2e.js`), Selenium C# avec NUnit (`tests/E2E/*Tests.cs`), Ruby avec RSpec
   (`spec/e2e/*_spec.rb`), JavaScript avec Mocha (`test/e2e/*.e2e.cjs`) ou WebdriverIO en
   TypeScript (`test/specs/*.e2e.ts`), dans le dossier de tests que le projet a déjà quand il en
   a un. Un seul modèle d'étapes pour les dix ; les WebDriver partagent un parcours
   (`codegen_webdriver.py`, langues dans `codegen_webdriver_langs.py`) et ne diffèrent que par
   leur dialecte. Un survol, un défilement, un glisser-déposer et une liste multiple passent par
   l'API du framework (`hover`, `dragTo`, `selectOption([…])`, `ActionChains`, `moveTo`…) ou par
   un script du générateur (défilement, drag HTML5, options multiples en WebDriver) ; un
   dialogue est répondu avant l'action (`page.once("dialog")`, `cy.on("window:confirm")`) ou
   après elle (`switch_to.alert`, `acceptAlert`).
   - **Littéraux** (`codegen_text.py`) : tout texte de la page entre par le littéral de la
     langue cible, qui se relit exactement : JSON non-ASCII échappé (JS, TS) ; `\x`, `\u`, `\U`
     (Python : un caractère hors BMP reste un caractère) ; Java avec `\"`, `\\`, `\n`… et
     `\uXXXX` pour le reste, jamais pour un guillemet, un antislash ou un saut de ligne, que
     javac décode avant de lire le source (JLS 3.3). Aucun gabarit, f-string ni interpolation :
     `${}` reste du texte. C# : `\"`, `\\`, `\uXXXX` ; Ruby entre guillemets doubles, `\#`
     seulement devant `{`, `@` et `$`. Une chaîne XPath passe par `xpath_string` (`concat()` quand elle a
     les deux guillemets). Cypress `type` reçoit `parseSpecialCharSequences: false`. Aucun texte
     de page dans un commentaire.
   - **Sélecteurs** : chaque framework prend le premier sélecteur qu'il sait écrire. Cypress n'a
     pas de requête par rôle ou label ; WebDriver trouve par CSS (test id, placeholder, CSS) ou
     par XPath (label, texte, rôle nommé par son texte) et, dans un shadow root, par CSS
     seulement. Une étape sans sélecteur exprimable reste un commentaire `step skipped`. Une
     place s'écrit `.nth(i)` (Playwright) ou `.eq(i)` (Cypress, seulement pour une requête qui
     rend toutes les correspondances : `cy.contains` n'en rend qu'une, un rôle ou un texte placé
     passe donc au sélecteur suivant) ; WebDriver la garde pour un placeholder ou un texte, qu'il
     trouve dans le même ordre que la page (`locate(…, nth)`), et passe au suivant pour le reste.
   - **Données saisies** (`codegen_data.py`) : une valeur tapée dans un champ (ni secret, ni
     vide) sort des étapes ; le test la lit par une clé. Clé : mots ASCII du label, du
     placeholder, du test id, du nom accessible ou du `name`/id du champ (`[a-z][a-z0-9_]*`,
     40 caractères), sinon le genre de la valeur ; le même champ retapé avec la même valeur
     garde sa clé, sinon `_2`, `_3`… Genre (`email`, `date`, `number`, `phone`, `url`, `name`,
     `text`) par règles seulement, forme de la valeur puis mots du champ : aucun modèle ne voit
     une valeur saisie. Où vivent les données, dans l'idiome de chaque framework : un JSON à côté
     du test (`<test>.data.json`) que Playwright TS lit par `testInfo.file`, Python par
     `Path(__file__)`, Selenium JS par `__dirname` (`.cjs`), WebdriverIO par `import.meta.url`
     (ESM), Ruby par `__dir__` dans un `let(:test_data)` ; Cypress : une fixture
     `cypress/fixtures/recorded/<test>.json`, `cy.fixture(…).as("data")` ; Java et C# : un bloc de
     constantes `TestData` en tête de classe (lire un JSON y demanderait une bibliothèque ou une
     règle de build). Chaque clé et valeur entre par le littéral de la langue (JSON pour le
     fichier). Le main relit la réponse (`browser-recorder-data.ts` : clés `[a-z0-9_]`, genres en
     liste fermée, fichier en `.json`) ; la carte de revue écrit le fichier dans son worktree, à
     côté du test, chemin relu dans le worktree ; « Enregistrer dans un fichier… » le pose à côté
     du fichier choisi, sous son propre nom. L'onglet montre les clés, leur genre et le fichier
     en texte.
   - **Cadres et shadow roots** : `frameLocator` / `frame_locator` puis `locator(hôte)`
     (Playwright perce les shadow roots ouverts) ; `its("0.contentDocument.body")` puis
     `.shadow()` (Cypress, iframe de même origine seulement) ; `switch_to.frame` puis
     `shadow_root` (Selenium) ; `switchToFrame` puis `shadow$` (WebdriverIO).
   - **Attentes** : `toBeVisible`, `be.visible` ou une recherche qui attend l'affichage ;
     `waitForResponse`, `expect_response`, `cy.intercept` + `cy.wait` ; pour WebDriver, un
     script du générateur (pas de la page) compte les `fetch` et XHR avant l'action et attend
     qu'un nouveau soit parti et qu'aucun ne soit en cours ; la page d'arrivée par son URL sans
     query ni fragment (`waitForURL`, `cy.url()`, `current_url`) ; l'indicateur de chargement
     jusqu'à ce qu'aucun ne soit visible (`locator(…).locator("visible=true")` à 0, `:visible`
     à 0 dans Cypress) ou que le premier soit caché ou parti (`invisibility_of_element_located`,
     `isDisplayed`), dans le document principal. Selenium et WebdriverIO attendent aussi chaque
     élément avant d'agir (`WebDriverWait`, `waitForExist`).
8. **Les destinations** : « Aperçu » (rien n'est écrit) ; « Proposer sur une carte de revue »
   (`openReviewRun(…, "browser-recorder", …)` : le fichier va dans le worktree de la carte, sur
   sa branche, commit `test(e2e): add recorded test <nom>`) ; « Enregistrer dans un fichier… »
   (boîte native ouverte sur Téléchargements ; un chemin dans un projet de cet ordinateur est
   refusé : c'est le rôle de la carte). Jamais dans le dossier du projet.

9. **Après l'export** (`main/browser-recorder/recorder-run.ts`, `recorder-assist.ts`) :
   - **Lancer** le dernier test proposé sur une carte de revue, dans le worktree de la carte
     (`runner run`, `browser_agent/recorder_run.py`) : la recette du worktree d'abord
     (`prepare_worktree`, qui garde son approbation), puis le lanceur du format (`npx playwright
     test`, `pytest`, `npx cypress run`, `npx mocha`, `npx wdio run`, `dotnet test`, Maven ou
     Gradle, `bundle exec rspec`), environnement statique, sans shell, 10 min au plus. Un test qui
     lit un secret dans l'environnement n'est pas lancé : la personne le lance avec ses
     variables. La sortie (fin, clés masquées) est montrée en texte. Le premier lancement de
     chaque test (empreinte de son code) est compté dans `.workpilot/browser-agent/recorder-runs.json`
     (500 au plus) : combien de tests enregistrés passent au premier essai.
   - **Revérifier** (`runner reshoot`, `browser_agent/recorder_replay.py`) : l'enregistrement
     arrêté est rejoué sans fenêtre ; chaque étape essaie ses sélecteurs dans l'ordre : trouvé,
     changé (seul un suivant trouve l'élément, qui est redécrit dans la page et reçoit de
     nouveaux sélecteurs par `build_selectors`), introuvable ou action en échec (le rejeu
     s'arrête, la suite est « non atteinte »). Les dialogues sont répondus comme enregistré. Le
     main garde les propositions ; une étape ne change que quand la personne les applique, par
     id.
   - **Nommer et classer** (`runner assist`, `browser_agent/recorder_assist.py`) : le modèle
     rapide du provider choisi, par `agent_runtime` (`create_agent_client`), type d'agent
     `recorder_assist` sans outil ni roster, nomme le test et classe les vérifications
     proposées. Il reçoit ce que les étapes disent de la page, cité comme donnée
     (`quote_untrusted`), jamais une valeur saisie ; sa réponse JSON est relue (nom masqué de
     80 caractères, ids de l'enregistrement). Sans provider, ou si le modèle échoue, des règles
     donnent la même réponse. C'est le seul runner de l'enregistreur qui reçoit l'environnement
     d'un provider (`pythonRunnerEnv`).

## Frontières

- **S2** : texte, labels, URL et valeurs de la page sont des données : bornés, en listes fermées,
  écrits en littéral échappé. Une page peut appeler la liaison elle-même et inventer des étapes ;
  elles restent des données que la personne relit dans la liste et dans le diff de la carte.
- **S6** : l'adresse (http(s) seulement, 2 048 caractères), le format (dix valeurs) et la destination
  (listes fermées) et les ids d'étapes sont relus dans le main ; les cadres, hôtes et attentes
  d'une étape sont relus par `parseRecordedStep` (au plus 4 sélecteurs bornés, méthode en liste
  fermée, chemin sans query, place entière de 0 à 19, sélecteur d'indicateur dans les cinq
  formes, `after` en id d'étape sur une vérification seulement) puis par `Recording.from_dict` ;
  une vérification proposée n'est exportée que si le renderer la nomme, par son id ; le dossier du projet passe par
  `DIRECTORY_ARGS`. Une réponse à un dialogue (`readDialogAnswer`) ne part que pour l'id en
  attente ; lancer, revérifier et nommer ne prennent que le projet, appliquer des ids d'étapes :
  worktree, fichier, format et étapes restent ceux du main. Le nom du test et l'adresse sont passés au runner en `--option=valeur` : une
  valeur qui commence par `-` n'est pas lue comme une option.
- **S4** : sous-processus sans shell ; le chemin proposé par le générateur est résolu dans le
  worktree et doit garder l'extension du format ; le test lancé est relu dans le worktree de la
  carte avec la même règle.
- **S1** : seul `assist` a un provider et sa clé ; il n'envoie aucune valeur saisie.
- **S7** : un projet en hors-ligne strict n'enregistre qu'une page de cet ordinateur
  (`localhost`, boucle locale).

## Pas encore fait

- Données saisies : une fixture Cypress suppose le dossier `cypress/fixtures` par défaut
  (`fixturesFolder` d'un projet n'est pas lu) ; WebdriverIO lit son JSON par `import.meta.url`,
  donc un projet ESM (le défaut de WebdriverIO, et le test généré importe déjà en ESM). Une
  réponse tapée dans un `prompt()` et l'option choisie dans une liste restent dans le test.
- Lancer un test qui lit des secrets : l'app lance sans identifiants, la personne le lance avec
  ses variables. Un test proposé dans un fichier (hors projet) n'est pas lancé non plus : seul
  le worktree d'une carte a la recette du projet.
- Cypress : un survol est un `mouseover` (Cypress n'a pas de vrai survol, une règle `:hover`
  n'est pas appliquée) ; un glisser au pointeur dans Selenium et WebdriverIO passe par les
  actions W3C, qu'une page HTML5 n'entend pas toujours.
- Hors de portée : un shadow root fermé, que ni le script de la page ni WebDriver n'atteignent ;
  une iframe d'une autre origine dans Cypress, qui n'y entre pas ; un projet du serveur (mode
  serveur), car la fenêtre du navigateur s'ouvre sur cet ordinateur.

Vérification : `pytest tests/browser_agent -q` (dont `test_codegen_text.py` : un littéral par
langage relu par sa langue, Java selon JLS 3.3, et une valeur saisie relue depuis les données de
chaque format ; `test_codegen_data.py` : clés, genres, secrets jamais en données ; `test_recorder_checks.py` : places, attentes
d'indicateur, vérifications proposées ; `test_recorder_actions.py`, `test_codegen_actions.py` :
survols, défilements, glisser, dialogues, nouvelles langues ; `test_recorder_run.py`,
`test_recorder_replay.py`, `test_recorder_assist.py`) ;
`cd apps/frontend && pnpm test -- browser-recorder Recorder`.
