---
name: cross-platform-mobile
description: Développement mobile multiplateforme — Flutter, React Native, Expo, .NET MAUI, Kotlin Multiplatform, Capacitor. À utiliser quand un même code source doit produire l'application Android et l'application Apple : choix de la stack, code partagé vs code natif, build par plateforme.
paths: "**/pubspec.yaml,**/app.json,**/metro.config.js,**/capacitor.config.*,**/*.csproj,**/settings.gradle.kts"
metadata:
  workpilot:
    pack: mobile
---

# Mobile multiplateforme

Un tronc commun ne supprime pas les deux plateformes : il supprime la duplication
de la logique. Les permissions, la revue de store, les cycles de vie et les
conventions d'interface restent deux sujets distincts, et c'est là que se
concentrent les défauts d'une app multiplateforme.

## Choisir — et le dire dans le plan

| Stack | Ce qu'elle apporte | Ce qu'elle coûte |
|---|---|---|
| **Flutter** | rendu identique partout, itération très rapide | apparence non native par défaut ; ponts à écrire pour les API système peu courantes |
| **React Native / Expo** | réutilise l'écosystème JS/TS, Expo supprime la config native | dépendances natives = retour à Xcode/Gradle ; Expo Go ≠ build natif |
| **.NET MAUI** | un seul C# avec le back-end, XAML | écosystème de composants plus étroit ; `dotnet test` échoue sur une tête MAUI |
| **Kotlin Multiplatform** | logique partagée, **UI native** de chaque côté | deux UI à écrire — c'est le choix, pas un oubli |
| **Capacitor** | réemploi direct d'une app web existante | performances et rendu d'une webview ; `cap sync` oublié = build précédent prévisualisé |

Le choix se justifie dans le plan par les contraintes du projet — équipe,
existant, exigences de rendu — pas par préférence.

## Règles qui ne changent pas selon la stack

1. **Construire les deux têtes**, pas seulement celle qui tourne sur la machine.
   Quand l'une n'est pas constructible ici, le dire dans le rapport.
2. **Le code partagé ne contient aucune condition de plateforme dispersée.** Une
   abstraction explicite (interface + implémentation par plateforme) au lieu de
   `if (Platform.isIOS)` répété dans dix fichiers.
3. **Les permissions restent natives.** Le manifeste Android et l'`Info.plist`
   doivent être modifiés, quelle que soit la couche au-dessus.
4. **Après toute modification de dépendance native** : `pod install` (iOS),
   resynchronisation Gradle (Android), `npx cap sync` (Capacitor),
   `dotnet workload restore` (MAUI).
5. **Tester sur les deux**, au minimum sur un émulateur Android et un simulateur iOS.

## Commandes par stack

```bash
# Flutter
flutter devices && flutter run -d <device>
flutter build apk --debug          # Android
flutter build ios --simulator      # iOS, macOS uniquement
flutter test && flutter analyze

# React Native / Expo
npx react-native run-android | npx expo run:android
npx react-native run-ios     | npx expo run:ios     # macOS uniquement
cd ios && pod install                                # après toute dépendance native

# .NET MAUI
dotnet build App.csproj -t:Run -f net10.0-android
dotnet build App.csproj -t:Run -f net10.0-ios -p:_DeviceName=:v2:udid=<udid>

# Kotlin Multiplatform
./gradlew :androidApp:installDebug
./gradlew :shared:iosSimulatorArm64Test
```
