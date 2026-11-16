---
section: 🐛 Corrections
---

- **Réglages → Comptes** : à l'ouverture, un fournisseur configuré jamais testé l'est une seule
  fois, au lieu d'être retesté à chaque rafraîchissement de la liste pendant les tests des autres.
  « Réessayer » relance le chargement au lieu de recharger toute la fenêtre. Couper un
  fournisseur de la bascule automatique ne s'affiche plus comme fait quand l'enregistrement
  échoue, et les messages nomment le fournisseur par son nom.
- **Bascule automatique** : ouvrir le panneau ne relit plus l'ordre des comptes et les profils
  Claude en boucle. Le seuil de session suit le curseur et s'enregistre une fois relâché, au lieu
  d'enregistrer chaque cran et de bloquer le curseur pendant le glissement. Un réglage qui n'a pas
  pu être enregistré revient à sa valeur enregistrée, un ordre des comptes refusé le dit et la
  liste reprend l'ordre enregistré, et chaque interrupteur porte le nom de son libellé. La poignée
  de chaque compte de la liste de priorité nomme le compte, et l'aide d'un compte à reconnecter ne
  propose plus un clic qui ne faisait rien.
- **Terminaux de connexion** (Claude, Codex, outils en ligne de commande, GitHub Copilot) : un
  terminal fermé pendant sa création ne reste plus ouvert en arrière-plan. La connexion Codex
  n'affiche plus une fausse adresse « Codex CLI User ». Copilot reconnaît la ligne finale de
  `gh auth login` (« Logged in as … ») et son compte, et une connexion ratée peut être relancée
  dans le même terminal. Le bouton de fermeture a un nom lisible par les lecteurs d'écran.
- **GitHub d'un projet** : un jeton obtenu par la connexion GitHub rouvre la liste des dépôts au
  lieu du champ de jeton manuel. Les interrupteurs, le jeton, le dépôt et les boutons
  d'actualisation ont un nom lisible par les lecteurs d'écran.
- **Azure DevOps d'un projet** : la liste des dépôts est lue une fois, au lieu d'être relue à
  chaque rendu, et le dépôt du remote git n'est détecté qu'une fois par projet ; une détection
  arrivée après un changement de projet n'est plus appliquée à l'autre. Un dépôt enregistré absent
  de la liste reste affiché. Les champs, interrupteurs et le bouton d'affichage du jeton ont un nom.
- Retiré, avec la preuve : un bouton « supprimer » de carte de fournisseur qui ne faisait rien
  et qu'aucune carte n'affichait, une branche Windsurf OAuth que le registre rend impossible, et
  des données d'usage jamais remplies. Ces écrans sont testés par leur comportement.
