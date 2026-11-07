# SDK and MSBuild Breaking Changes (.NET 10)

Official list: https://learn.microsoft.com/dotnet/core/compatibility/10 (checked 2026-11-07).

These changes affect the .NET SDK, CLI tooling, NuGet, and MSBuild behavior.

## Source-Incompatible Changes

### NU1510 raised for direct references pruned by NuGet

If NuGet prunes a direct `PackageReference` because the package is already part of the shared framework, a `NU1510` warning is raised. Remove the explicit reference if it's provided by the framework.

### PackageReference without a version raises an error

Every `<PackageReference>` must now have a `Version` attribute or use Central Package Management. Missing versions raise an error instead of resolving to the latest.

### Other source-incompatible changes

- `dnx.ps1` file removed from .NET SDK — remove any references
- File-level directives (`#r`, `#load`) no longer accept double-quoted paths — remove the quotes (e.g., `#r MyLib.dll` instead of `#r "MyLib.dll"`)
- `project.json` no longer recognized by `dotnet restore` — use `PackageReference` format
- NuGet packages with no runtime assets excluded from `deps.json`
- `ToolCommandName` not set for non-tool packages
- HTTP sources in `dotnet package list`/`dotnet package search` now error (use HTTPS)

## Behavioral Changes

### `dotnet new sln` defaults to SLNX file format

`dotnet new sln` now generates an XML-based `.slnx` file instead of the classic `.sln` format:
```xml
<Solution>
</Solution>
```
**Mitigation:** Use `dotnet new sln --format sln` for the classic format. Ensure your tooling (Visual Studio, Rider, etc.) supports SLNX.

### `DefineConstants` TFM symbols not available at evaluation time

`NET9_0_OR_GREATER`, `NETSTANDARD2_0` and the other SDK-set symbols are computed in a target
now, so `Condition="$(DefineConstants.Contains('NET9_0_OR_GREATER'))"` in a project file is
silently false. Use the MSBuild functions instead:

```xml
<ItemGroup Condition="$([MSBuild]::IsTargetFrameworkCompatible('$(TargetFramework)', 'net9.0'))">
```

Search project files for `DefineConstants.Contains` and `DefineConstants)` in conditions;
constants you define yourself are unaffected.

### Insecure HTTP NuGet sources become errors

- `dotnet package list` / `dotnet package search` turn the HTTP-source warning into an error.
- From SDK 10.0.400, an `auditSource` on `http://` raises NU1302 and stops restore.

Move the feed to HTTPS. `allowInsecureConnections="true"` in `nuget.config` exists, but it is
a decision for the person who owns the feed, not something to add to get a green build.

### Other behavioral changes

- `--interactive` defaults to `true` in user scenarios — use `--interactive false` in scripts
- CLI diagnostic output now goes to stderr
- Tool packages now include RID-specific content
- Default workload management mode is 'workload sets' (not 'loose manifests')
- `EnableDynamicNativeInstrumentation` defaults to false for code coverage
- `dotnet package list` performs restore before listing
- `dotnet tool install --local` creates manifest by default
- `dotnet watch` logs to stderr instead of stdout
- `PrunePackageReference` privatizes direct prunable references (`PrivateAssets="All"`)
- SHA-1 fingerprints deprecated in `dotnet nuget sign` — use SHA-256
- `MSBUILDCUSTOMBUILDEVENTWARNING` escape hatch removed
- MSBuild custom culture resource handling changed
- `NUGET_ENABLE_ENHANCED_HTTP_RETRY` env var removed (enhanced retry always on)
- NuGet logs errors for invalid package IDs
