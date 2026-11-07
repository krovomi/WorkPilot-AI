# .NET MAUI and .NET for Android/iOS changes (.NET 11)

Official list: the ".NET MAUI" section of
https://learn.microsoft.com/dotnet/core/compatibility/11 (snapshot 2026-11-07). The big
one: **mobile targets run on CoreCLR instead of Mono.**

## Runtime switch (binary/source incompatible)

- **CoreCLR replaces Mono** for .NET mobile apps; code generation on mobile changes
  from Mono to CoreCLR.
- **Mono project properties and Mono runtime settings no longer configure the app**:
  they are ignored. Remove them and use the CoreCLR equivalents the articles list.
- **Mono embedding APIs are not supported** on mobile; native code calling
  `mono_*` functions must be rewritten against hosting APIs.
- **Debugging moves to ICorDebug** and **CoreCLR trace events replace Mono's**: update
  custom diagnostics and profilers; IDE debugging needs current tooling.
- **Crash-reporting behavior changes**: re-test the crash reporter on a device.
- **`UnwindNativeCode` is not supported on Apple targets.**

## Platform minimums

- **Android minimum API level is 24** (Android 7.0): raise `SupportedOSPlatformVersion`
  for `net11.0-android`.
- **Android x86 is not supported** (32-bit emulator images): use x86_64 or arm64
  emulators and drop `android-x86` from `RuntimeIdentifiers`.

## How to proceed

Retarget (`net11.0-android`, `net11.0-ios`, …), remove Mono-only properties, build each
platform, then run the app on a real device or emulator for each target the machine can
build (iOS only on macOS). Startup time, memory and native-library loading are the areas
the runtime switch moves most: measure them before and after.
