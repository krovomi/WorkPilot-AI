---
name: windev-text-format
description: Modifier sans les casser les fichiers d'un projet WinDev, WebDev ou WinDev Mobile sauvegardé au format texte (option Git, version 25 et plus) — où vit le code WLangage dans un .wdw, .wdc, .wdg, .wdp, .wde ou .wwh, ce qui ne se touche jamais, comment ajouter une procédure, et ce qui reste à faire dans l'éditeur.
paths: "**/*.wdp,**/*.wdw,**/*.wdc,**/*.wdg,**/*.wde,**/*.wdt,**/*.wwh"
metadata:
  workpilot:
    pack: windev
---

# Format texte des éléments WinDev

Deux formats coexistent. Le **natif** est binaire : le fichier commence par `PCS` et le reste est
compressé ; rien ne s'y lit ni ne s'y écrit hors de l'éditeur. Le **format texte** (option
« Format de sauvegarde des éléments » de la description du projet, version 25 et plus) est un
YAML dont la première ligne est :

```text
#To edit and compare internal_properties, use WINDEV integrated tools.
```

Un fichier sans cette ligne n'est pas modifiable par un agent, quelle que soit son extension.

## Ce qui est texte, ce qui reste binaire

| Fichier | Élément | Format texte possible |
| --- | --- | --- |
| `.wdp` | projet (liste des éléments, code d'initialisation) | oui |
| `.wdw` | fenêtre | oui |
| `.wdc` | classe | oui |
| `.wdg` | collection de procédures | oui |
| `.wde` | état | oui |
| `.wdt` | modèle | oui |
| `.wwh` | page WebDev | oui |
| `.wda`, `.wdd` | analyse | non |
| `.wdr` | requête | non |
| `.wxt` | scénario de test automatique | non |
| `.fic`, `.ndx`, `.mmo` | données HFSQL | non (données) |

## Anatomie d'un élément

```yaml
#To edit and compare internal_properties, use WINDEV integrated tools.
#Internal properties refer to the properties of controls in windows, reports, etc.
info :
 name : COL_Clients
 major_version : 27
 minor_version : 0
 type : 7
 description : ""
 subtype : 0
procedure_set :
 identifier : 0x1e724aee00158928
 internal_properties : BgAAAAYAAAB2/vstTMCJbS/hlxjFxirSqKvCUuv8
 code_elements :
  type_code : 31
  p_codes : []
  procedures :
   -
     name : CalculeRemise
     procedure_id : 2193899737526465975
     type_code : 15
     code : |1-
      PROCEDURE CalculeRemise(nMontant est un monétaire) : monétaire
      SI nMontant <= 0 ALORS RENVOYER 0
      RENVOYER nMontant * 0.1
     type : 458752
```

- Le code vit **uniquement** dans les blocs `code : |1+` ou `code : |1-`. Chaque ligne du bloc est
  indentée d'**exactement une espace de plus** que la clé `code` ; ce qui suit cette espace
  (tabulations comprises) est le WLangage. Une ligne moins indentée termine le bloc et casse le
  fichier. `|1+` garde les lignes vides finales, `|1-` les retire : l'indicateur existant reste tel
  quel.
- Le `type` écrit sous un bloc est le code de l'événement (clic, initialisation, procédure
  locale…) : il ne change jamais.
- Dans une fenêtre, les champs sont sous `controls` ; chacun porte ses événements dans son propre
  `code_elements`. Le `name` le plus proche au-dessus d'un bloc dit à quoi il appartient.

## Ce qui ne se touche jamais

- Une ligne `internal_properties`, `identifier` ou `procedure_id` existante, et le bloc `info` :
  ce sont des valeurs produites par l'éditeur (base64 chiffré, identifiants 64 bits). Une valeur
  changée, copiée ou supprimée rend l'élément illisible.
- Un fichier binaire WinDev, une analyse, une requête, un scénario `.wxt`, un fichier de données.
- La structure autour du code : les clés, leur ordre, les listes `controls`, `elements`,
  `configurations` du projet.

Pas de création d'élément (fenêtre, classe, collection, état, page) : l'éditeur l'inscrit dans le
`.wdp` avec des propriétés qu'aucun agent ne sait produire. Pas de champ nouveau dans une
fenêtre, pas de propriété de champ (libellé, taille, liaison) : tout cela est dans
`internal_properties`.

## Ajouter une procédure à une collection ou une classe existante

Recopier une procédure sœur **du même type** dans la même liste `procedures`, puis :

1. changer `name` et le code du bloc ;
2. donner un `procedure_id` nouveau : un entier décimal sur 19 chiffres qui n'existe nulle part
   dans le projet ;
3. garder `type_code` et `type` de la sœur ;
4. ne recopier ni `identifier` ni `internal_properties` : si la sœur en a, choisir une autre sœur
   qui n'en a pas, ou laisser l'ajout à l'éditeur.

Le rapport dit que l'élément doit être rechargé une fois dans l'éditeur pour confirmer l'ajout.

## Ce qui reste à faire dans l'éditeur

Le rapport de la tâche liste, sous `À faire dans l'éditeur WinDev`, tout ce qui ne peut pas
s'écrire en texte : éléments, champs et propriétés à créer, rubriques d'analyse, requêtes, et
dans tous les cas la recompilation et le lancement des tests automatiques. Aucune compilation
n'est possible hors de l'éditeur : « compile » ne s'affirme jamais.

## Conflits Git

Un conflit dans un bloc `code` se résout comme du code ordinaire, en gardant l'indentation du
bloc. Un conflit sur une ligne `internal_properties` ne se résout pas à la main : il se règle en
ouvrant l'élément dans l'éditeur.
