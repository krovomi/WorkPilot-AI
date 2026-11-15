---
section: 🧪 Filets de test
---

- **Couverture backend, lot B4a (revue de code)** : le point de revue humaine avant le build (résumé de la spec et du plan, éditeur, avis, approbation), le score de qualité et ses analyseurs (clones, performance, couverture statique, Java, Kotlin, C#, Go, Rust, motifs appris, règles du projet, historique et badges) passent à 100 %, sur de vrais fichiers ; seule la recherche grepai est remplacée.
- **Revue de code** : les clones à l'intérieur d'un même fichier sont détectés (un fichier comparé à lui-même ne rendait jamais rien) ; plusieurs lignes supprimées d'affilée comptent toutes, et chacune porte son numéro dans l'ancien fichier ; l'analyse étendue (Java, Kotlin, C#, Go, Rust) ne plante plus sur chaque fichier et analyse le code au lieu de son chemin.
- **Corrections automatiques** : un fichier corrigé garde ses fins de ligne (un fichier CRLF devenait LF, et inversement sous Windows).
- **Couverture statique** : un projet rangé sous un dossier dont le nom contient « test » n'est plus vu sans aucune source, le dernier nom d'un import est reconnu, et le nombre de fichiers de test est bien celui des fichiers.
- **Règles personnalisées** : `**/*.py` s'applique aussi aux fichiers à la racine du projet.
- **Historique qualité** : la tendance n'est plus inversée (« en progrès » pour un score qui baisse), le rapport d'une revue sans numéro de PR s'enregistre sous Windows (le nom portait des « : »), et l'URL du badge n'est plus coupée par le « / » de « 95/100 ».
- **Point de revue** : l'éditeur se trouve aussi sous Windows (la recherche passait par `which`), `$EDITOR` peut porter des arguments (`code --wait`), une ligne de tableau qui contient le mot « file » n'est plus prise pour l'en-tête, et `[X]` compte comme une case cochée.
- **Performance** : des boucles imbriquées sous un `if` ou un `with` comptent comme imbriquées.
