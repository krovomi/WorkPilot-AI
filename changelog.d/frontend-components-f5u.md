---
section: 🐛 Corrections
---

- **Import Jira et Azure DevOps** : les panneaux d'import et la fenêtre d'import Azure DevOps
  vérifiaient la connexion (et relisaient la liste après un échec) à chaque rendu tant qu'ils
  étaient ouverts ; ils la vérifient une fois à l'ouverture. Une recherche entourée d'espaces
  trouve l'élément qu'elle vient de charger ; le compteur « +N » de la sélection Azure DevOps
  s'affiche correctement ; la confirmation d'un import Jira parle de tickets et affiche leur clé
  (`PROJ-1`, plus `#PROJ-1`) ; un import Azure DevOps qui n'importe rien dit pourquoi ; changer de
  projet ne garde plus la liste ni la largeur du projet précédent ; les boutons du panneau
  (réduire, fermer, rafraîchir) ont un nom traduit et lisible par les lecteurs d'écran.
- Les deux panneaux et la fenêtre partagent maintenant un même composant
  (`components/work-item-import/`) au lieu de trois copies.
