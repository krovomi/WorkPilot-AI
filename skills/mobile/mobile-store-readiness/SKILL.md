---
name: mobile-store-readiness
description: Audit avant publication sur le Play Store et l'App Store — permissions, déclarations de confidentialité, signature, targetSdk, entitlements, métadonnées. À utiliser avant une release mobile, ou quand une modification touche aux permissions, aux données collectées ou à la configuration de build.
paths: "**/AndroidManifest.xml,**/Info.plist,**/*.entitlements,**/PrivacyInfo.xcprivacy,**/build.gradle.kts"
metadata:
  workpilot:
    pack: mobile
---

# Prêt pour les stores

Les rejets de store coûtent des jours et **aucun test du dépôt ne les attrape** :
ce sont des règles sur des fichiers de configuration et sur des comportements que
la suite de tests ne regarde pas. C'est la seule raison d'être de cette phase —
poser ces questions pendant que la correction est un fichier, pas une release.

En lecture seule. Elle produit une liste de constats ; le correctif appartient à
la phase de codage.

## Android — Play Store

- [ ] `targetSdk` au niveau exigé par Play (le refus est automatique en dessous).
- [ ] Chaque permission du manifeste est **utilisée**, et chaque permission
      dangereuse est demandée à l'exécution au moment de l'usage.
- [ ] Aucune permission ajoutée par une dépendance sans qu'on l'ait décidé
      (`./gradlew :app:processReleaseManifest` puis lire le manifeste fusionné).
- [ ] `android:debuggable` absent du build de release ;
      `usesCleartextTraffic` désactivé ou justifié par une config réseau.
- [ ] Artefact de release **signé** avec le keystore de production, jamais avec
      la clé de debug ; keystore hors du dépôt.
- [ ] `versionCode` strictement supérieur au précédent.
- [ ] R8/ProGuard actif, et le build de release réellement testé après
      minification — c'est là que la réflexion casse, pas en debug.
- [ ] Déclaration Data Safety cohérente avec ce que le code envoie réellement.

## Apple — App Store

- [ ] Une chaîne `NS…UsageDescription` pour **chaque** API sensible utilisée.
      Absente, l'app ne demande rien : elle plante.
- [ ] `PrivacyInfo.xcprivacy` présent et à jour, y compris pour les SDK tiers qui
      l'exigent.
- [ ] Suppression de compte disponible si l'app permet d'en créer un.
- [ ] Aucune API privée, y compris via une dépendance.
- [ ] Entitlements cohérents avec le profil de provisionnement.
- [ ] Exceptions ATS justifiées, ou supprimées.
- [ ] Compte de démonstration fourni si une fonctionnalité est derrière un login.
- [ ] Icônes et captures pour toutes les tailles requises.

## Les deux

- [ ] Aucun secret, clé d'API ou point d'entrée de préproduction dans le binaire.
- [ ] Politique de confidentialité atteignable depuis l'app.
- [ ] Textes de store et captures cohérents avec ce que l'app fait.

## Sortie

Pour chaque constat : le fichier, la ligne, la règle, et ce que verrait le
relecteur du store. Un constat sans règle nommée est une suggestion — l'étiqueter
comme telle.
