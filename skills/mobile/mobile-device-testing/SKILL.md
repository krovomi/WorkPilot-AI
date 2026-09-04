---
name: mobile-device-testing
description: Vérifier une application smartphone sur un appareil réel ou virtuel — démarrer un émulateur Android ou un simulateur iOS, installer le build, lancer l'app, capturer l'écran et les logs, lire un crash. À utiliser quand une modification mobile doit être constatée en fonctionnement, pas seulement compilée.
metadata:
  workpilot:
    pack: mobile
---

# Tester sur appareil

Une app mobile qui compile et ne s'affiche pas correctement est le mode d'échec
normal ici. La preuve utile n'est ni un test unitaire vert ni un build réussi :
c'est une capture d'écran de l'application lancée, et le log du processus.

## Trouver un appareil

```bash
adb devices -l                         # Android : appareils et émulateurs démarrés
emulator -list-avds                    # Android : AVD définis mais éteints
xcrun simctl list devices available    # iOS : simulateurs disponibles
```

Aucun résultat n'est un résultat. Pas d'`adb` : le SDK Android n'est pas installé
(`ANDROID_HOME`). Pas de `xcrun` : la machine n'est pas un Mac, et **aucune
tentative** ne changera cela — le dire une fois et s'arrêter là.

## Démarrer, installer, lancer

```bash
# Android
emulator -avd <nom> -no-snapshot-load &
adb wait-for-device
adb install -r <chemin>.apk
adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1

# iOS
xcrun simctl boot <udid>
xcrun simctl install booted <chemin>.app
xcrun simctl launch booted <bundle-id>
```

Un émulateur froid met une minute à démarrer. `adb wait-for-device` rend la main
dès que le démon répond, pas quand l'écran d'accueil est prêt : attendre
`adb shell getprop sys.boot_completed` égal à `1`.

## Capturer la preuve

```bash
adb exec-out screencap -p > shot.png
xcrun simctl io booted screenshot shot.png
```

## Lire les logs — ceux de l'app, pas ceux de l'appareil

```bash
adb logcat --pid=$(adb shell pidof -s <package>)
adb logcat -b crash                                   # crashs uniquement
xcrun simctl spawn booted log stream --predicate 'processImagePath endswith "<App>"'
```

Un `adb logcat` sans filtre produit des milliers de lignes du système : le crash
recherché s'y perd, et le contexte se remplit pour rien.

## Rapporter

Installé ? Lancé ? Que voit-on ? Chaque crash avec sa pile et le fichier source
correspondant. Ne rien corriger : ce rôle constate.
