---
name: android-developer
description: Développement d'applications Android natives (Kotlin, Jetpack Compose, Gradle, Hilt, Room, Coroutines). À utiliser pour créer, structurer, construire, tester et publier une application Android — architecture, cycle de vie, permissions, build sur émulateur, publication Play Store.
paths: "**/AndroidManifest.xml,**/build.gradle,**/build.gradle.kts,**/*.kt,**/*.java,**/gradle.properties"
metadata:
  workpilot:
    pack: mobile
    targets:
      android: ">=8.0"
---

# Développeur Android

Une application Android n'est pas une application web dans un cadre plus petit.
Le système peut détruire le processus à tout moment, l'utilisateur peut faire
pivoter l'écran, retirer une permission, ou revenir en arrière au milieu d'un
formulaire — et chacun de ces événements est **normal**, pas un cas d'erreur.

## Stack de référence

- **Langage** : Kotlin, coroutines + Flow. Java uniquement sur du code existant.
- **UI** : Jetpack Compose (`ViewModel` + `StateFlow`), Material 3.
- **Injection** : Hilt.
- **Données** : Room, DataStore, Retrofit/Ktor + OkHttp.
- **Build** : Gradle avec wrapper committé, version catalog (`libs.versions.toml`).
- **Tests** : JUnit 5 + Turbine (unitaires), Compose UI Test / Espresso (instrumentés), Robolectric.

## Ce qu'il faut vérifier avant de dire « terminé »

1. **Le build passe** — `./gradlew :app:assembleDebug`. Toujours le wrapper : un
   Gradle système d'une autre version échoue avec une erreur qui ressemble à une
   erreur de source.
2. **L'app démarre sur un appareil** — `./gradlew :app:installDebug` puis
   `adb shell monkey -p <applicationId> -c android.intent.category.LAUNCHER 1`.
   `installDebug` **n'ouvre pas** l'application.
3. **Rien ne bloque le thread principal** — activer StrictMode en debug ; toute
   I/O, base ou réseau part sur un dispatcher.
4. **La rotation et la mort du processus** — `adb shell am kill <package>` puis
   revenir : l'état doit être là. `SavedStateHandle`, pas un champ d'Activity.
5. **Les permissions** — déclarées dans le manifeste **et** demandées au moment
   de l'usage. Une permission déclarée jamais demandée échoue en silence sur
   Android 13+.
6. **Le retour arrière** — geste de retour prédictif respecté ; l'avaler est le
   reproche le plus fréquent des revues Play Store.

## Architecture

```
app/
├── data/          repositories, sources distantes et locales, mappers
├── domain/        modèles et use cases, sans dépendance Android
├── ui/            écrans Compose + ViewModels, un state holder par écran
└── di/            modules Hilt
```

Le module `domain/` ne connaît ni Android ni Room : c'est ce qui rend ses tests
instantanés et ce qui permet de le partager avec une cible KMP plus tard.

## Commandes

```bash
./gradlew :app:assembleDebug            # build
./gradlew :app:installDebug             # installer sur l'appareil connecté
./gradlew :app:testDebugUnitTest        # tests unitaires (JVM, rapides)
./gradlew :app:connectedAndroidTest     # tests instrumentés — exige un appareil
./gradlew :app:lintDebug                # lint Android
adb logcat --pid=$(adb shell pidof -s <package>)   # logs de l'app seule
adb exec-out screencap -p > shot.png    # capture d'écran
```

`connectedAndroidTest` sans appareil démarré échoue avec « no connected devices »,
ce qui n'est pas un échec de test : vérifier `adb devices` avant de conclure.

## Publication

- `versionCode` incrémenté à chaque envoi, `versionName` lisible.
- Build de release **signé** avec un keystore hors du dépôt.
- `minifyEnabled true` + règles ProGuard/R8 vérifiées sur un build de release réel.
- Déclaration Data Safety à jour dès qu'une donnée collectée change.
- `targetSdk` au niveau exigé par Play — le refus est automatique en dessous.
