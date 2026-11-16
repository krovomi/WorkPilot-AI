---
section: 🐛 Corrections
---

- **Génération de tests** : le sélecteur de fichier ouvre bien le dossier du fichier déjà choisi
  (racine comprise), reste utilisable quand un dossier ne se lit pas, et ses boutons d'effacement
  ont un nom lisible par un lecteur d'écran ; le champ de destination personnalisée aussi.
- **Studio de tests** : la coloration du code reconnaît un attribut Rust (`#[test]`), garde un
  décrément (`i--`) comme du code, et ne colle plus une chaîne ou un attribut à la ponctuation
  qui le précède ; « Copié » ne s'affiche qu'une fois la copie réussie.
- **Issues GitHub** : l'état, la complexité et le nombre de commentaires d'une issue sont
  traduits, comme les messages de liste vide, d'erreur et le filtre ; une recherche ne charge
  plus les issues deux fois ; la page suivante se charge aussi quand la première arrive très
  vite ; une vérification de connexion qui échoue dit pourquoi et n'affiche plus le dépôt du
  projet précédent.
- **Regrouper les issues** : ce sont bien les lots validés qui sont cochés d'office, un échec
  de création des tâches s'affiche sans perdre la sélection au lieu de laisser l'assistant
  bloqué, et les cases des lots ont un nom lisible par un lecteur d'écran.
- **Créer une tâche depuis une issue** : un échec de lecture des commentaires est signalé au
  lieu de laisser croire que l'issue n'en a pas.
