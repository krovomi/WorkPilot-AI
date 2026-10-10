# L'émulateur d'application

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## L'adresse qu'ouvre l'émulateur (`shared/utils/emulator-landing.ts`)

L'aperçu ouvrait la racine du serveur. C'est la bonne réponse pour un site et la
mauvaise pour tout le reste : une Web API .NET répond 404 sur `/`, et la page que
la tâche vient d'écrire est trois segments plus loin. L'utilisateur voyait donc,
pour une fonctionnalité qui marche, un cadre vide et « HTTP 404 ».

Le diff de la tâche dit précisément quelle route a été touchée. C'est une preuve
mesurée, pas une convention devinée, et ce module est le seul endroit qui la lit
— ni modèle ni réseau, seulement des chemins et des lignes ajoutées, si bien que
l'UI peut poser la question avant d'avoir démarré quoi que ce soit.

`deriveLandingCandidates` rend *toutes* les adresses plausibles, la plus probable
d'abord, dans l'ordre de la force de la preuve :

| Rang | Source | Ce qui la produit |
|---|---|---|
| 1 | `route-declaration` | `[Route("api/[controller]")]`, `app.MapGet`, `@Controller`, `<Route path>`, `@app.get`, `@RequestMapping`… lus dans les **lignes ajoutées** du patch |
| 2 | `file-route` | une page créée par convention : `app/x/page.tsx`, `pages/x.vue`, `src/routes/x/+page.svelte`, `app/routes/x.new.tsx` |
| 3 | `launch-profile` | le `launchUrl` que le projet déclare dans `Properties/launchSettings.json` |
| 4 | `api-docs` | la page d'accueil du framework : `/swagger`, `/docs`, `/api` |

Rendre la liste plutôt que la seule réponse est ce qui permet au panneau d'échec
de proposer les autres : un 404 sur la première devient un bouton vers la
deuxième, pas un cul-de-sac.

**Un segment dynamique arrête la route.** `api/users/{id}/roles` devient
`/api/users` : la liste existe presque toujours, l'identifiant non, et inventer
un `id` produirait un 404 en prétendant l'éviter. `[controller]` fait exception —
c'est un jeton à substituer, pas un paramètre, et son nom vient de la classe que
le patch déclare, sinon du fichier, parce qu'ASP.NET *impose* que
`DocumentsController` vive dans `DocumentsController.cs`.

**Un motif trop courant est réservé aux fichiers de routes.** `path:` est une clé
de configuration autant qu'une route Angular ; `deriveLandingCandidates` ne la
lit que dans un fichier dont le nom le dit (`*routes*`, `*router*`, `urls.py`,
`*-routing.*`). Sans cette règle, un `{ path: 'dist/assets' }` de build devenait
l'adresse proposée à l'utilisateur.

**La barre d'adresse est une vraie barre d'adresse.** `ResponsivePreview` porte
Précédent / Suivant / Recharger / Accueil et un champ éditable :
`resolveAddressInput` résout ce qui est tapé contre le serveur de l'émulateur. Le
défaut est *relatif* — dans cette barre on tape « /swagger » cent fois pour une
fois où l'on tape un hôte — et un hôte n'est reconnu que quand il se nomme (un
point, un port, ou `localhost`). Tout ce qui n'est pas http(s) est refusé avec un
message : un `file://` chargé dans l'aperçu serait une navigation que personne
n'a demandée.

La navigation passe par `loadURL`, jamais par un changement de `key` : remonter
le `<webview>` perdrait l'historique, et l'historique est ce que lisent les deux
boutons. `src` reste le repli — c'est tout ce dont dispose un environnement de
test, et c'est aussi ce qui fait la première navigation.

**« Ouvrir dans le navigateur » ouvre ce qui est affiché**, pas la racine du
serveur : après une navigation dans l'aperçu les deux ne sont plus la même page,
et sur une Web API la racine est précisément celle qui répond 404. Côté main,
`open-external.ts` est le seul chemin : il valide le schéma, appelle
`shell.openExternal`, et **sur Linux seulement** essaie ensuite les lanceurs que
la machine a vraiment (`xdg-open`, `gio open`, `x-www-browser`…) — Electron y
rejette quand `xdg-utils` manque ou que le portail XDG n'est pas joignable. Le
rejet remonte jusqu'au renderer, qui l'affiche : un bouton qui ne fait rien et ne
dit rien est la pire des deux options, et c'est ce que l'utilisateur voyait.

**Et il n'ouvre que ce qui s'ouvre.** Un `<webview>` n'annonce pas seulement les
adresses qu'on lui a demandées : `about:blank` avant sa première navigation, et
`chrome-error://chromewebdata/` dès qu'une page n'a pas répondu — ce qui est le
cas courant ici, puisqu'une Web API répond 404 sur la racine. Ces valeurs
arrivaient telles quelles à `open-external.ts`, qui les refuse à juste titre sur
le schéma : le bouton ne produisait plus qu'un message d'erreur, pour une page
que le serveur sert très bien deux segments plus loin. `isBrowsableUrl` est la
seule réponse à « est-ce une adresse ? » — la barre ne suit plus ce qui n'en est
pas une, et le bouton retombe sur la racine du serveur, toujours ouvrable. Le
message d'échec, lui, est rendu comme un échec : il était rendu en texte courant,
au milieu d'un panneau qui n'avait pas changé par ailleurs.

**L'adresse survit au changement d'onglet.** `TabsContent` démonte le panneau
qu'on quitte, donc une adresse gardée dans `ResponsivePreview` est une adresse
perdue à l'aller — l'utilisateur revenait sur l'onglet Émulateur et retrouvait la
route d'accueil. Elle vit dans `app-emulator-store` (`previewUrls`), **indexée
par tâche** : le serveur est unique, les pages qu'on y regarde ne le sont pas, et
une seule adresse ferait ouvrir la tâche B sur la page de la tâche A. Un autre
serveur les vide toutes — la page d'un run précédent n'existe plus.

Ce qui est mémorisé est une page où l'on est *allé* : une saisie, un lien suivi,
un candidat cliqué. Pas la route d'accueil que l'aperçu ouvre tout seul, ni le
premier `did-navigate` qui ne fait que la confirmer — le diff de la tâche est lu
une seconde après le montage, donc une racine mémorisée comme un choix gagnerait
contre la route que ce diff révèle. C'est la même distinction que porte le second
argument d'`onNavigate`.
