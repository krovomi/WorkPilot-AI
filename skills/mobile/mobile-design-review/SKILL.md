---
name: mobile-design-review
description: Relecture d'une interface mobile avant l'écriture du code — navigation, cibles tactiles, états de chargement et d'erreur, accessibilité TalkBack/VoiceOver, conventions Material et Human Interface. À utiliser sur une tâche qui ajoute ou modifie un écran d'application smartphone.
paths: "**/*.kt,**/*.swift,**/*.dart,**/*.tsx,**/*.xaml"
metadata:
  workpilot:
    pack: mobile
---

# Revue de conception mobile

Une phase de relecture, pas de correction : elle produit un rapport, elle ne
modifie rien. Elle se place avant le codage parce qu'un écran mal découpé se
corrige en une phrase à ce moment-là et en un cycle complet après la QA.

`design-check` (impeccable) couvre déjà le web. Ce qu'il ne couvre pas, et qui
est ici :

## Ce qui se vérifie

**Navigation** — la profondeur de pile est-elle bornée ? Le retour (geste
Android, swipe iOS) ramène-t-il où l'utilisateur croit ? Un écran atteignable
uniquement par un chemin qu'on ne peut pas rejouer est un écran qu'on ne peut
pas tester.

**Cibles tactiles** — 48 dp minimum sur Android, 44 pt sur iOS. Une icône de
24 dp sans zone tactile élargie est inutilisable en marchant.

**Les quatre états de chaque écran** — chargement, vide, erreur, contenu. L'état
vide et l'état d'erreur sont ceux qu'on oublie, et ce sont ceux que l'utilisateur
voit le premier jour, avant d'avoir des données.

**Hors-ligne** — le téléphone perd le réseau plusieurs fois par jour. Que montre
l'écran ? Que devient une saisie en cours ?

**Accessibilité** — chaque élément interactif porte un libellé (`contentDescription`,
`accessibilityLabel`). Dynamic Type / échelle de police système respectée :
une mise en page en points fixes casse à la plus grande taille.

**Conventions de plateforme** — Material 3 côté Android, Human Interface côté
Apple. Une app Android qui imite une barre de navigation iOS n'est pas cohérente,
elle est étrangère aux deux.

**Clavier** — le champ actif reste-t-il visible quand le clavier monte ? Le type
de clavier correspond-il au champ (email, numérique, mot de passe) ?

## Sortie

Une liste de constats, chacun avec : l'écran, la règle enfreinte, ce que voit
l'utilisateur. Un constat qu'on ne peut pas rattacher à une règle ou à une
conséquence visible est une préférence — le dire ainsi et passer.
