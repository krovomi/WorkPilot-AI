---
feature: Matrice d'appareils de l'émulateur
summary: >-
  La page de l'aperçu rendue par le main sur des appareils prédéfinis (fenêtre, densité, user
  agent, tactile), sous un bridage réseau et processeur nommé, capturée appareil par appareil, vue
  en grille, lue en lecture seule pour les bugs responsive (débordement, médias, cibles tactiles,
  petit texte, chevauchements, texte coupé) et exportée en une image PNG.
---

# La matrice d'appareils de l'émulateur (#383)

L'aperçu de l'émulateur (`ResponsivePreview.tsx`) montrait une page à la fois, dans un format
choisi à la main (`FORMATS` : quelques largeurs et des points de rupture). Il ne changeait ni la
densité de pixels, ni le user agent, ni le tactile, et tester le responsive voulait dire
redimensionner, regarder, recommencer — en oubliant un appareil.

Le bouton **Matrice d'appareils** de l'aperçu ouvre une grille : on coche des appareils, on
choisit au besoin un réseau (4G, 3G rapide, 3G lente) et un ralentissement du processeur, on
capture, chacun s'affiche côte à côte avec ce que la lecture de la page y a trouvé et le temps
qu'elle a mis à se charger. Une capture peut être gardée pour la revue visuelle de la tâche (même
chemin que la capture unique de l'aperçu : `docintel-visual-store`) ; **Exporter** enregistre la
grille entière en une image PNG.

## Le catalogue (`shared/constants/device-presets.ts`)

Dix appareils en données typées (`DevicePreset`, `shared/types/device-matrix.ts`) : iPhone 15 et
15 Pro Max, Pixel 8 et 9, Galaxy Z Fold 5 plié, iPad Mini et Pro, ordinateur Full HD, écran 4K
(2560 × 1440 à 150 %), téléviseur 16:9. Chacun porte sa fenêtre CSS, sa densité, le drapeau
`mobile` (balise `viewport` appliquée), le drapeau `touch` et le user agent du navigateur livré
avec l'appareil. Les valeurs suivent les profils d'appareils des DevTools de Chromium.

Le catalogue est partagé parce que le renderer le propose et que le main n'émule que lui : le
renderer **nomme** un appareil par son `id`, il ne le décrit jamais. Un id inconnu est refusé
(`unknown-device`).

## Qui capture : le main, jamais une URL du renderer

`app-emulator:capture-device` (`ipc-handlers/device-matrix-handlers.ts`) reçoit
`{ deviceId, path, network, cpu }` et rien d'autre (le preload ne transmet que ces quatre champs,
le handler les relit). `network` et `cpu` sont des **identifiants** de profil, jamais une latence,
un débit ou un facteur : un id hors de la liste est refusé (`unknown-throttling`) avant tout rendu.

- L'**origine** est celle du serveur que l'émulateur a lancé (`appEmulatorService.getUrl()`). Sans
  serveur, refus (`not-running`).
- Le **chemin** doit commencer par `/`, tenir en 2 048 caractères, sans caractère de contrôle ; il
  est résolu sur cette origine et refusé si l'URL obtenue en sort (`//hôte`, `/\hôte`, URL
  complète). C'est la comparaison d'origine qui tranche, pas une liste de motifs.
- **Une capture à la fois** (`busy` sinon). Le renderer enchaîne les appareils : il a ainsi la
  progression et l'arrêt sans canal d'évènements, et la machine ne rend qu'une page à la fois (le
  cas « six aperçus lourds en parallèle » de l'issue est évité par construction).

Le renderer envoie le chemin de la page affichée quand elle est sur le serveur de l'émulateur ;
sinon (une adresse saisie ailleurs) la matrice le dit et rend la racine du serveur.

## Le bridage (`shared/constants/emulation-throttling.ts`)

Deux listes fermées, partagées comme le catalogue : le renderer les propose, le main n'applique
qu'elles. Les valeurs sont celles des profils intégrés aux DevTools de Chromium.

| Profil réseau | Latence | Descendant | Montant | Chargement laissé |
|---|---|---|---|---|
| `none` | — | — | — | 30 s |
| `4g` | 165 ms | 1 012 500 o/s | 168 750 o/s | 30 s |
| `fast-3g` | 563 ms | 180 000 o/s | 84 375 o/s | 60 s |
| `slow-3g` | 2 000 ms | 50 000 o/s | 50 000 o/s | 120 s |

Processeur : `1x`, `2x`, `4x`, `6x` (`Emulation.setCPUThrottlingRate`). Le temps laissé au
chargement est celui du réseau multiplié par le ralentissement, plafonné à 180 s ; les 800 ms
laissées à une application monopage pour se dessiner sont multipliées de même. Sans profil
(`none`, `1x`), rien n'est envoyé au protocole : la capture est celle d'avant.

## Le rendu (`main/device-matrix/device-capture.ts`)

Même architecture que le scan d'accessibilité dynamique (`accessibility/dynamic-scan.ts`) :

- fenêtre cachée, `sandbox`, `contextIsolation`, sans Node, sans preload, sans `webviewTag` ;
- session en mémoire `device-matrix` (pas de cache, vidée après chaque capture) qui refuse toute
  permission (demande et vérification) et tout téléchargement ;
- `setWindowOpenHandler` refuse, `will-navigate` / `will-redirect` empêchent de quitter l'origine ;
- l'appareil est posé **avant** le chargement, par le protocole des DevTools :
  `Emulation.setDeviceMetricsOverride` (fenêtre, densité, `mobile`),
  `Emulation.setTouchEmulationEnabled`, `Emulation.setUserAgentOverride` (et
  `webContents.setUserAgent`), pour que les media queries, `pointer: coarse` et le serveur voient
  le même appareil que l'image ;
- le bridage est posé ensuite, toujours avant le chargement : `Network.enable` puis
  `Network.emulateNetworkConditions` pour un profil réseau, `Emulation.setCPUThrottlingRate` pour
  un ralentissement. Si le protocole refuse l'un d'eux, la capture échoue (`throttling-failed`)
  plutôt que de montrer comme « 3G lente » une page chargée sans bridage. Si une version de Chromium
  retirait `emulateNetworkConditions` (déprécié au profit de `emulateNetworkConditionsByRule`),
  `session.enableNetworkEmulation` d'Electron sur la session dédiée ferait le même travail ;
- chargement borné (30 s sans bridage, voir le tableau, `load-failed`), mesuré jusqu'à `load`
  (`loadMs`, rendu au renderer), puis le temps de se dessiner, puis `Page.captureScreenshot` (PNG
  aux pixels physiques, plafonné à 48 Mo de base64, `capture-failed` au-delà) ;
- la fenêtre est détruite quoi qu'il arrive.

Les échecs sont une liste fermée (`DeviceCaptureError`) que le renderer traduit ; aucun message
d'exception ne traverse l'IPC.

## La lecture de la page (`main/device-matrix/responsive-probe.ts`)

`RESPONSIVE_PROBE` tourne dans un **monde isolé** (`executeJavaScriptInIsolatedWorld`) : il
partage le DOM de la page mais pas ses globales, donc la page ne peut pas remplacer
`getComputedStyle` ou `getBoundingClientRect` sous ses pieds. Il ne fait que lire (aucune écriture
dans le DOM, aucun évènement, vérifié par le test) et s'arrête à 4 000 éléments (rapport marqué
partiel). Ses options sont écrites dans le main à partir du preset, jamais reçues.

| Bug | Règle | Où |
|---|---|---|
| Débordement horizontal | un élément visible dépasse la fenêtre ; compté une fois (ses descendants ne sont plus examinés, ni ceux d'un conteneur qui coupe ou fait défiler son contenu) ; plus la largeur du document au-delà de la fenêtre | tous |
| Média trop large | `img`, `video`, `canvas`, `svg`, `iframe`… qui dépasse la fenêtre | tous |
| Cible tactile trop petite | lien (avec `href`), bouton, champ, `role` interactif de moins de 44 × 44 px (Apple HIG, WCAG 2.5.5) ; un lien en ligne est exempté, comme dans WCAG | écran tactile |
| Texte trop petit | un élément qui porte du texte en moins de 12 px (Lighthouse) | mobile |
| Éléments qui se chevauchent | deux éléments qui portent un contenu (texte, média, cible interactive), hors de toute couche `fixed`, `sticky` ou `absolute` (en-tête collant, badge sur une icône : voulus), visibles (`opacity` non nulle), dont aucun ne contient l'autre, qui se recouvrent sur plus de 2 px dans chaque sens et sur au moins 25 % de la plus petite boîte ; comparés deux à deux parmi les 500 premiers ; l'exemple est l'intersection, nommée `a / b` | tous |
| Texte coupé ou qui déborde | un élément non `inline` qui porte du texte et dont le contenu dépasse la boîte sans qu'on puisse la faire défiler : `scrollWidth > clientWidth` (points de suspension, `overflow: hidden`, mot trop long) ou `scrollHeight > clientHeight` (hauteur fixe trop petite, `line-clamp`) | tous |

Ce que le script rend reste une réponse de la page : `sanitizeReport` ne garde que les sortes
connues, des nombres finis et bornés, au plus 10 exemples par sorte, des sélecteurs
`balise#id.classe` (ou `a / b` pour un chevauchement) de 120 caractères au plus sans caractère de
contrôle. Aucun texte de la page n'est rapporté. Le rapport est une donnée affichée ; il n'est
envoyé à aucun agent.

## L'export de la grille (`main/device-matrix/grid-export.ts`)

`app-emulator:export-device-grid` reçoit `{ deviceIds }` : des ids du catalogue (au plus dix,
sans doublon, un id inconnu refuse la requête), ceux que la grille affiche comme rendus. Le
renderer ne fournit **ni pixel, ni texte, ni chemin** :

- les **images** sont les dernières captures du main lui-même, gardées en mémoire une par
  appareil (jamais sur disque) ; un appareil jamais capturé est laissé de côté, aucun :
  `nothing-to-export` ;
- les **légendes** (nom de l'appareil, fenêtre, bridage) sont écrites par le main dans la langue de
  l'app, à partir des mêmes textes `appEmulator.json` que le renderer (`grid-labels.ts`) ;
- le **fichier** est celui que la personne choisit dans la boîte d'enregistrement native
  (`showSaveDialog`, `device-matrix.png` proposé) ; annuler n'écrit rien. Seul le nom du fichier
  revient au renderer, pour le message « Grille enregistrée sous … ».

Chaque capture est réduite à sa case par `nativeImage` (540 px de large, 1 400 px de haut au plus,
quatre colonnes), puis la grille est dessinée dans un `<canvas>` d'une fenêtre cachée en bac à
sable, sans preload, sur `about:blank` d'une session en mémoire sans permission, qui ne navigue ni
n'ouvre de fenêtre. Les légendes sont dessinées par `fillText` : du texte, jamais du HTML
interprété. Ce que la page rend n'est écrit que si c'est un PNG (`data:image/png`, base64, en-tête
PNG) de 64 Mo au plus ; au-delà de 30 s, `export-failed`. L'export et les captures partagent le
verrou « une chose à la fois » (`busy`). Échecs en liste fermée (`DeviceGridExportError`),
traduits par le renderer ; aucun message d'exception ne traverse l'IPC.

## Le renderer

- `stores/device-matrix-store.ts` : la sélection (ordre du catalogue) et le résultat de chaque
  appareil. Le lot tourne dans le store et non dans le composant, parce que l'onglet Émulateur est
  démonté quand on en regarde un autre. « Arrêter » termine l'appareil en cours ; ceux qui n'ont
  pas été rendus disparaissent de la grille.
  Il garde aussi les profils choisis (appliqués à la capture suivante) et l'état de l'export.
- `components/app-emulator/DeviceMatrix.tsx` : cases par famille, listes « Réseau » et
  « Processeur », grille côte à côte, conditions du rendu (bridage, temps de chargement) et
  rapport par appareil, bouton **Exporter**. Ouvrir la matrice cache l'aperçu sans démonter le
  `<webview>`, qui garde son historique.
- Textes en `en` et `fr` (`appEmulator:devices.*`, `appEmulator:matrix.*`).

## Tous les stacks, et ce qui ne s'applique pas

La matrice rend ce que sert le serveur de l'émulateur : elle vaut pour tout projet dont l'aperçu
est web, quel que soit le langage ou le framework détecté (React, Angular, Vue, Next, Django,
Rails, ASP.NET, Blazor, Flutter web, Expo web…). Aucun LLM n'intervient : indépendant du provider,
et hors ligne.

Une application mobile **native** (build iOS ou Android, React Native hors web, Flutter natif)
n'est pas rendue par Chromium : les presets, la densité émulée et la lecture de la page ne s'y
appliquent pas, et la matrice n'apparaît que dans l'aperçu web. Pour ces projets, le cadre
d'appareil de l'émulateur mobile reste la vue à utiliser ; la taille des cibles tactiles et du
texte y relève des outils d'accessibilité de la plateforme.

## Pas encore fait

- Presets personnalisés et orientation paysage (aujourd'hui : un preset = une orientation).
- Session partagée avec l'aperçu (cookies, connexion) et cookies de persona : la matrice rend une
  session vierge, donc une page derrière une connexion montre l'écran de connexion.
- Navigation synchronisée et rechargement à chaud simultané sur plusieurs vues vivantes (la
  matrice montre des captures, pas des pages interactives).
- Détection d'une navigation mobile cassée ; repère des éléments fautifs dessiné sur la capture ;
  relecture après chaque redimensionnement.
- Export de la grille en PDF (le PNG est fait), matrice affichée d'office sur 3-4 appareils à la
  revue d'une carte UI du Kanban, envoi des captures à la boucle Design-to-Code.
- Bridage hors ligne et profils réseau personnalisés (latence et débits saisis) : volontairement
  absents, le renderer ne nomme qu'un profil de la liste.
