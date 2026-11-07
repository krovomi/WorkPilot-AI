# Épinglage des outils MCP (*tool poisoning*, *rug pull*)

Un serveur MCP tiers est du code et du texte qui parlent directement au modèle, avec les droits de
la tâche. La **description** d'un outil, et celles de ses paramètres, sont lues par le modèle et
jamais montrées à la personne : c'est là qu'Invariant Labs (avril 2025) a montré qu'on cache des
instructions (*tool poisoning* : lire `~/.cursor/mcp.json` et le passer en paramètre, ne rien dire
à l'utilisateur, détourner l'outil d'un autre serveur). Un serveur approuvé peut aussi changer ses
descriptions la semaine suivante (*rug pull*). La parade : épingler chaque outil par l'empreinte de
ce que lit le modèle, et retenir ce qui a changé tant que la personne ne l'a pas revu.

Code :

- `apps/backend/mcp_pins/`, un module feuille : empreintes, détection, registre, route desktop ;
- `apps/backend/core/mcp_pinning.py` : la sonde et le filtrage des deux chemins ;
- l'écran : `components/settings/McpPinsSection.tsx`, dans Outils des agents → serveurs MCP.

## Ce qui est épinglé

Seuls les serveurs personnalisés (`CUSTOM_MCP_SERVERS`). Les serveurs de WorkPilot (`workpilot`,
Context7, Electron, Puppeteer, Chrome DevTools…) ne le sont pas : ils font partie du produit.

- **Empreinte d'un outil** : SHA-256 du JSON canonique de `name`, `description`, `inputSchema` et
  `annotations`. Une description de paramètre modifiée change l'empreinte.
- **Empreinte d'une configuration** : type, commande, arguments, URL, et les *noms* des variables
  d'environnement et des en-têtes, jamais leurs valeurs. Une commande ou une URL changée fait d'un
  serveur un nouveau serveur.

## Le registre : `.workpilot/mcp-pins.json`

Un fichier par projet, dans le checkout principal. Le worktree d'une tâche,
`.workpilot/worktrees/tasks/<spec>`, lit celui de son projet. Il est protégé en écriture contre les
agents, comme le reste de la configuration de sécurité (`PROTECTED_CONFIG_DIRS` de
`security/path_guard.py`) : un agent qui pourrait l'écrire approuverait son propre serveur. Un
fichier illisible n'approuve rien.

**Premier usage.** Exiger une approbation pour chaque serveur déjà configuré éteindrait, à la mise
à jour, des serveurs que la personne a installés elle-même. Donc la première lecture du registre
note les configurations présentes à ce moment (`trusted_configs`). Chacun de ces serveurs est
épinglé au premier contact si aucune description ne paraît piégée. Un serveur ajouté ensuite, par
la personne dans l'app ou par n'importe quoi qui écrit `.workpilot/.env`, attend une approbation.

| Ce que la sonde voit | Statut | Pont WorkPilot | SDK Claude |
|---|---|---|---|
| exactement les outils approuvés (un outil retiré est noté) | approuvé | tous ses outils | démarré |
| un outil ajouté ou une description changée | modifié | les outils inchangés | **non démarré** |
| commande ou URL changée | modifié | aucun outil | non démarré |
| serveur jamais approuvé | à approuver | aucun outil | non démarré |
| serveur injoignable, ou HTTP en hors-ligne strict (S7) | inconnu | aucun outil | non démarré |

Sur le SDK Claude, c'est Claude Code qui ouvre le serveur et montre au modèle tout ce qu'il liste :
WorkPilot ne peut pas retirer un seul outil, donc le serveur entier attend. Pour le savoir avant la
session, `core/mcp_pinning.py` ouvre le serveur lui-même : démarrage, liste des outils, fermeture,
sans jamais appeler un outil. Une sonde sert dix minutes par serveur et configuration, et
l'approbation est relue à chaque session. Le pont WorkPilot (`MCPToolManager`, providers
OpenAI-compatibles et locaux) liste les outils de toute façon et n'expose que les approuvés. Les
agents en CLI (Codex, OpenCode, Gemini CLI…) ne reçoivent pas `CUSTOM_MCP_SERVERS`.

## La détection (`mcp_pins/scan.py`)

Elle passe sur chaque description nouvelle ou modifiée, paramètres compris. Les signes sont
volontairement peu nombreux et précis, parce qu'un signe retient le serveur jusqu'à une
confirmation explicite :

- caractères invisibles, bidirectionnels, de balise ou à usage privé ;
- balise adressée au modèle (`<IMPORTANT>`, `<system>`, `[INST]`…) ;
- demande de cacher quelque chose à la personne ;
- nom d'un fichier d'identifiants ou de configuration (`~/.ssh/`, `id_rsa`, `mcp.json`, `.npmrc`…) ;
- étape exigée avant d'utiliser l'outil (« avant d'utiliser cet outil, lis… ») ;
- ordres sur d'autres outils, ou nom d'un outil d'un autre serveur configuré (*shadowing*) ;
- longueur anormale, et ce que `injection_guard` classe haut ou critique.

## Approuver

La section n'apparaît que lorsqu'un serveur attend. Elle montre chaque outil retenu, l'ancienne
description barrée au-dessus de la nouvelle, et les signes trouvés. « Approuver » épingle ce que la
dernière sonde a vu. Si un outil porte un signe, le backend refuse, et le bouton devient
« Approuver quand même » : un second clic, explicite. La route `/api/mcp-pins` est réservée au
desktop (`LOCAL_ONLY_FEATURES`, permission du domaine `settings`). Le chemin du projet est
revalidé par la politique IPC (argument 0).

## Plus tard

- Le mode serveur : un registre par projet côté serveur et une permission dédiée, pour qu'un membre
  n'approuve pas seul un serveur pour toute l'équipe.
- L'alerte sur la carte de la tâche ; aujourd'hui elle est dans le journal de la session et dans
  Outils des agents.
