# Microsoft.Extensions breaking changes (.NET 11)

Hosting, dependency injection, configuration, options, file providers. Official
articles: https://learn.microsoft.com/dotnet/core/compatibility/extensions/11/ (snapshot
2026-11-07). These ship in the shared framework and the 11.0 packages, so they apply to
every app host — web, worker, console with a generic host.

## A failing `BackgroundService` now faults `RunAsync` / `StopAsync` (Preview 3)

The default `HostOptions.BackgroundServiceExceptionBehavior` is still `StopHost` (it has
been since .NET 6: the exception was never silently swallowed). What changes is the
task returned by `IHost.RunAsync`, `StopAsync` and `WaitForShutdownAsync`: it used to
complete successfully, so the process exited **0**; it now fails with the service's
exception (an `AggregateException` when several fail), so the process exits non-zero.

Recommended: do nothing — a crashed service should fail the process, and orchestrators
(Kubernetes, systemd, Windows services) can now see it. Review:

- scripts, health checks or tests that asserted exit code 0 after a service failure;
- a `try`/`catch` around `await host.RunAsync()` is the documented way to keep the old
  exit code — only when that is really wanted.

Do **not** wrap the whole body of `ExecuteAsync` in a catch-all to "avoid crashing the
host": that turns a dead worker into a silently idle one. Catch what the loop can
recover from, inside the loop, and let the rest propagate.

## Nine Microsoft.Extensions packages are in the shared framework (Preview 4)

`Caching.Abstractions`, `Configuration.Abstractions`, `DependencyInjection.Abstractions`,
`Diagnostics.Abstractions`, `FileProviders.Abstractions`, `Hosting.Abstractions`,
`Logging.Abstractions`, `Options`, `Primitives`.

- `net11.0`-only project: remove their `PackageReference` (they now raise **NU1510**),
  or the `PackageVersion` under CPM if nothing else uses it.
- Multi-targeting (`net10.0;net11.0`): no NU1510; keep the reference, optionally
  conditioned on `'$(TargetFramework)' != 'net11.0'`.
- The assemblies are no longer copied to the output folder.
- Rare type-name conflicts: add a more specific `using`, an alias, or a full name.
- A dependency compiled against an old version that fails with `MissingMethodException`
  / `TypeLoadException` must be upgraded or recompiled against .NET 11.

## Options

- **Synchronous access to async-validated options throws (RC1).** Only for options that
  use the asynchronous validation added in .NET 11 previews (`ValidateAsync`,
  `IAsyncValidateOptions<T>`): with only async validators, `IOptions<T>.Value`,
  `IOptionsMonitor<T>.CurrentValue`/`Get`, `IOptionsSnapshot<T>` and
  `IOptionsFactory<T>.Create` throw `OptionsValidationException`. Call
  `.ValidateOnStart()` and finish `await host.StartAsync()` before synchronous access,
  and keep one synchronous validator for snapshots and monitor reloads. A custom
  `IAsyncValidateOptions<T>` must now implement `Validate(string?, T)` (return
  `ValidateOptionsResult.Skip` or `Fail`). Code migrating from .NET 10 is unaffected
  unless it already adopted async validation.
- **The options validation source generator reports SYSLIB1205** for a type that also
  implements `Validate` explicitly. Keep one of the two.

## Configuration and file providers

- **Empty strings in a chained configuration override earlier providers.** Only through
  `AddConfiguration(...)` / `ChainedConfigurationSource`: a key set to `""` in the
  chained `IConfiguration` used to count as absent and now wins (binding `""` to an
  `int` then throws). Remove the key, or make it `null`, where the earlier value must
  win. No compatibility switch.
- **`FileConfigurationProvider` no longer raises its reload token after a load failure
  it ignored**, and **`FileConfigurationSource.OnLoadException` is also called for I/O
  errors**: handlers must not assume a parse error.
- **`PhysicalFilesWatcher` validates its root and `FileSystemWatcher` paths.**
- **`ChangeToken.OnChange` gained async overloads, and existing `Task`-returning
  callbacks rebind to them** on recompilation: check callbacks that relied on
  fire-and-forget.

## Dependency injection

- **Scope disposal aggregates exceptions**: several services throwing while a scope is
  disposed are reported together. Handlers around scope disposal that match one
  exception type must also look at `AggregateException.InnerExceptions`.

For any entry above whose impact is unclear, read its article before changing code.
