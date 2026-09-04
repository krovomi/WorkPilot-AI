---
name: ios-developer
description: Développement d'applications Apple pour iPhone et iPad (Swift, SwiftUI, Swift Concurrency, Xcode, SwiftData). À utiliser pour créer, structurer, construire, tester et publier une application iOS — architecture, cycle de vie, Info.plist, simulateur, revue App Store.
paths: "**/*.swift,**/Info.plist,**/*.xcodeproj/**,**/*.xcworkspace/**,**/Package.swift,**/Podfile"
metadata:
  workpilot:
    pack: mobile
    targets:
      ios: ">=16.0"
---

# Développeur iOS

Deux contraintes structurent tout le reste : **la chaîne d'outils Apple n'existe
que sur macOS**, et **la revue App Store rejette sur des règles qu'aucun test
n'attrape**. Un agent qui l'ignore passe une heure à faire échouer `xcodebuild`
sur un runner Linux, ou livre une app refusée pour une chaîne manquante dans un
`Info.plist`.

## Stack de référence

- **Langage** : Swift 6, `async/await`, acteurs, `Sendable`.
- **UI** : SwiftUI (`@Observable`, `@State`, `@Environment`). UIKit sur l'existant.
- **Données** : SwiftData ou Core Data, `URLSession` avec `Codable`.
- **Injection** : initialiseurs explicites ou `@Environment` — pas de singleton global.
- **Tests** : Swift Testing (`@Test`) ou XCTest, XCUITest pour l'UI.
- **Dépendances** : Swift Package Manager de préférence ; CocoaPods sur l'existant.

## Ce qu'il faut vérifier avant de dire « terminé »

1. **Le build passe sur simulateur** —
   `xcodebuild -workspace App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' build`.
   Toujours le `.xcworkspace` quand CocoaPods est en jeu : construire le
   `.xcodeproj` seul omet la cible Pods et échoue à l'édition de liens.
2. **L'app se lance** — `xcrun simctl boot <udid>`, `xcrun simctl install booted <chemin>.app`,
   `xcrun simctl launch booted <bundle-id>`.
3. **Chaque API sensible a sa chaîne dans Info.plist** — `NSCameraUsageDescription`,
   `NSLocationWhenInUseUsageDescription`… Sans elle, l'app ne demande pas la
   permission : **elle plante** au premier usage.
4. **Le thread principal reste libre** — l'UI sur `@MainActor`, le travail long en
   `async` ailleurs. Un à-coup sur le main thread est ce qu'un relecteur appelle
   « janky ».
5. **Safe area et Dynamic Type** — une mise en page en points fixes casse sur le
   plus petit appareil et à la plus grande taille d'accessibilité.
6. **Restauration d'état** — iOS suspend et termine librement ; revenir sur un
   écran vide se lit comme un crash côté utilisateur.

## Architecture

```
App/
├── Features/<Feature>/     vue SwiftUI + modèle observable, un dossier par écran
├── Core/                   modèles de domaine, protocoles de service
├── Data/                   clients réseau, persistance, mappers
└── Resources/              assets, Info.plist, chaînes localisées
```

## Commandes

```bash
xcrun simctl list devices available          # simulateurs installés
xcrun simctl boot <udid>                     # démarrer un simulateur
xcrun simctl install booted <chemin>.app     # installer
xcrun simctl launch booted <bundle-id>       # lancer
xcrun simctl io booted screenshot shot.png   # capture d'écran
xcodebuild -workspace App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --quiet
```

## Revue App Store — ce qui fait rejeter

- Suppression de compte absente alors que l'app permet d'en créer un.
- `PrivacyInfo.xcprivacy` manquant pour un SDK qui l'exige.
- Usage d'API privée, même indirect via une dépendance.
- Exception ATS sans justification dans `Info.plist`.
- Fonctionnalité inaccessible au relecteur (compte de démonstration à fournir).

## Sur une machine qui n'est pas un Mac

`xcodebuild` n'est pas installable ailleurs. Écrire le code, faire tourner ce
qui est vérifiable (tests de logique pure via SwiftPM sur Linux quand le paquet
le permet), puis **dire explicitement** dans le rapport que la cible iOS n'a pas
été construite et pourquoi. Un runner macOS (GitHub Actions `macos-latest`) ou un
service distant (EAS Build, Codemagic, Xcode Cloud) est la voie de sortie ; s'y
acharner localement n'en est pas une.
