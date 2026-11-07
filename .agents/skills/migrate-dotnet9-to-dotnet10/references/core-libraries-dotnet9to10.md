# Core .NET Libraries Breaking Changes (.NET 10)

Official list: https://learn.microsoft.com/dotnet/core/compatibility/10 (checked 2026-11-07).

These breaking changes affect all .NET 10 projects regardless of application type.

## Source-Incompatible Changes

### System.Linq.AsyncEnumerable included in core libraries

.NET 10 adds `System.Linq.AsyncEnumerable` with full LINQ support for `IAsyncEnumerable<T>`, replacing the community `System.Linq.Async` NuGet package. Projects referencing `System.Linq.Async` will get ambiguity errors.

**Fix:**
- Remove the `System.Linq.Async` package reference, or upgrade to v7.0.0
- If consumed transitively, suppress with `<ExcludeAssets>`:
  ```xml
  <PackageReference Include="System.Linq.Async" Version="6.0.1">
    <ExcludeAssets>compile</ExcludeAssets>
  </PackageReference>
  ```
- Rename `SelectAwait` calls to `Select` where the new API uses a different name

### API obsoletions (SYSLIB0058–SYSLIB0062)

| Diagnostic | What's obsolete | Replacement |
|------------|----------------|-------------|
| SYSLIB0058 | `SslStream.KeyExchangeAlgorithm`, `CipherAlgorithm`, `HashAlgorithm` and their strength properties | `SslStream.NegotiatedCipherSuite` — **Security note:** if existing code used these properties to reject weak ciphers (e.g., RC4, 3DES, NULL), ensure equivalent validation is preserved using `NegotiatedCipherSuite` |
| SYSLIB0059 | `SystemEvents.EventsThreadShutdown` | `AppDomain.ProcessExit` |
| SYSLIB0060 | `Rfc2898DeriveBytes` constructors | `Rfc2898DeriveBytes.Pbkdf2` static method |
| SYSLIB0061 | `Queryable.MaxBy`/`MinBy` overloads with `IComparer<TSource>` | New overloads with `IComparer<TKey>` |
| SYSLIB0062 | `XsltSettings.EnableScript` | N/A (XSLT scripting deprecated) |

These use custom diagnostic IDs — suppressing `CS0618` does not suppress them.

### FilePatternMatch.Stem changed to non-nullable

`FilePatternMatch.Stem` is now `string` instead of `string?`. Code checking for null may get warnings.

### Other source-incompatible changes (low impact)

- `[DynamicallyAccessedMembers]` annotation removed from `DefaultValueAttribute` constructor (affects trimming annotations)
- ARM64 SVE nonfaulting load intrinsics now require a mask parameter

## Behavioral Changes

### .NET runtime no longer provides default termination signal handlers

**Impact: High for console/containerized apps without Generic Host.**

On Unix, the runtime no longer registers SIGTERM/SIGHUP handlers. On Windows, `CTRL_SHUTDOWN_EVENT` and `CTRL_CLOSE_EVENT` are no longer handled. `AppDomain.ProcessExit` and `AssemblyLoadContext.Unloading` will NOT be raised on termination signals.

- **ASP.NET Core and Generic Host apps are unaffected** (they register their own handlers)
- **Console apps** must register handlers explicitly:
  ```csharp
  using var sigterm = PosixSignalRegistration.Create(
      PosixSignal.SIGTERM, _ => Environment.Exit(0));
  using var sighup = PosixSignalRegistration.Create(
      PosixSignal.SIGHUP, _ => Environment.Exit(0));
  ```

### C# 14 overload resolution with span parameters

Methods with `ReadOnlySpan<T>` or `Span<T>` parameters now participate in type inference and extension method resolution. This can cause `MemoryExtensions.Contains` to bind instead of `Enumerable.Contains` inside Expression lambdas, causing runtime exceptions.

**Fix:** Cast to `IEnumerable<T>`, use `.AsEnumerable()`, or call the static method explicitly:
```csharp
// Fails — binds to MemoryExtensions.Contains
M((array, num) => array.Contains(num));
// Fix options:
M((array, num) => ((IEnumerable<int>)array).Contains(num));
M((array, num) => array.AsEnumerable().Contains(num));
M((array, num) => Enumerable.Contains(array, num));
```

### BufferedStream.WriteByte no longer performs implicit flush

`BufferedStream.WriteByte` no longer flushes when the buffer is full. Add explicit `Flush()` calls if your code relied on the implicit behavior.

### Consistent shift behavior in generic math

Shift operations in generic math now behave consistently. If custom types relied on the previous inconsistent behavior, update them.

### Default trace context propagator updated to W3C standard

The default `DistributedContextPropagator` now uses W3C Trace Context format. If your system relies on legacy propagation formats, configure the propagator explicitly.

### Named mutexes default to user scope on Unix (servicing: 8.0.32, 9.0.21, 10.0.13)

**Impact: Medium, and it arrives with a patch, not with the retarget.** On Linux and macOS a
named `Mutex` is now visible only to the current user; it used to be global (backing file
under `/tmp/`). Two processes of **different users** sharing a mutex stop seeing each other.

- Cross-user mutex on .NET 10+: `new Mutex(false, "Name", NamedWaitHandleOptions.None)`.
- Any version: runtime option `System.Threading.Mutex.UnsafeDefaultMutexScopeGlobal=true` in
  `runtimeconfig.json` (named "unsafe" on purpose: the global file lets another user interfere).
- A container started with a UID that has no `/etc/passwd` entry (`docker run -u <uid>`,
  Kubernetes `runAsUser`) now fails to create a named mutex: set `XDG_RUNTIME_DIR` to a
  directory that UID owns, or create the user in the image.

### Other behavioral changes (lower impact)

- `DriveInfo.DriveFormat` returns actual Linux filesystem type names (e.g., `ext4`) instead of generic values
- `GnuTarEntry`/`PaxTarEntry` no longer include atime/ctime by default — set explicitly if needed
- LDAP `DirectoryControl` parsing is more stringent — invalid data now throws
- MacCatalyst versions normalized differently (affects .NET MAUI)
- `ActivitySource.CreateActivity`/`StartActivity` sampling behavior changed
- `[InlineArray]` structs can no longer have explicit `[StructLayout(Size = ...)]` — assembly fails to load
- `Type.MakeGenericSignatureType` arguments validated more strictly
