# SDK, MSBuild, NuGet and test-platform changes (.NET 11)

Official articles: https://learn.microsoft.com/dotnet/core/compatibility/sdk/11/
(snapshot 2026-11-07).

## Can break the build or restore

- **VSTest no longer depends on Newtonsoft.Json.** A test project that used
  `Newtonsoft.Json` without referencing it (it came through
  `Microsoft.NET.Test.Sdk`) now fails to compile or load: add an explicit
  `PackageReference`, or move the test helpers to `System.Text.Json`.
- **Restore no longer searches the global packages folder for a higher version.** A
  restore that only succeeded because a newer version sat in `~/.nuget/packages` fails
  (NU1102/NU1103 family): reference a version the configured feeds serve.
- **Template engine packages no longer support `netstandard2.0`**: custom template
  hosts or tools built on `Microsoft.TemplateEngine.*` must target a modern TFM.
- **NU1703** warns for packages using deprecated `MonoAndroid` framework assets.
- **NETSDK1235** warns when `PackAsTool=true` is combined with a custom `NuspecFile`:
  drop the custom nuspec for a .NET tool.
- **NuGet pack warns for package IDs with restricted characters.**
- **NU1510** for Microsoft.Extensions packages now in the shared framework — see
  `extensions`.

Each of these fails a `TreatWarningsAsErrors` build: fix the cause rather than adding
the code to `NoWarn`.

## Behavioral

- **`dnx` scripts bypass `global.json` SDK selection**: a `dnx <tool>` run uses the
  newest SDK installed, not the pinned one.
- **Native AOT publish skips the full build**: steps hooked on the build target of a
  `dotnet publish -p:PublishAot=true` may no longer run; hook them on publish.
- **NativeAOT CLI command handling enabled by default.**
- **The SDK's local container publishing prefers the platform's native runtime tool**
  (for `dotnet publish /t:PublishContainer` with a local daemon): set the runtime
  explicitly in CI where several are installed.
- **`mono` launch target no longer set for .NET Framework apps** on Linux/macOS: set it
  explicitly if `dotnet run` relied on Mono.
- **`dotnet publish --self-contained <value>` honours the value**: `--self-contained false`
  now really produces a framework-dependent app (dotnet/sdk#52333).
