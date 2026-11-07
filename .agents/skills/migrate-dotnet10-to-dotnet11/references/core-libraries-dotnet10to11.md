# Core .NET libraries breaking changes (.NET 11)

Official list: https://learn.microsoft.com/dotnet/core/compatibility/11 (snapshot
2026-11-07, RC2; the page is marked "work in progress"). Each entry has its own article
under `core/compatibility/core-libraries/11/`: read it when an entry applies and the fix
below is not enough.

## Obsoletions (source incompatible)

### SYSLIB0063 — `NamedPipeClientStream(PipeDirection, bool isAsync, bool isConnected, SafePipeHandle)`

`isConnected` never had an effect. Use the 3-parameter constructor:

```csharp
var pipe = new NamedPipeClientStream(PipeDirection.InOut, isAsync: true, safePipeHandle);
```

### SYSLIB0064 — `RSACryptoServiceProvider.Encrypt(byte[], bool)` / `Decrypt(byte[], bool)`

Use the overloads taking an `RSAEncryptionPadding` (`RSAEncryptionPadding.OaepSHA256`
for new data; `OaepSHA1` / `Pkcs1` only to read what was written with `true` / `false`).
Suppressing `CS0618` does not hide these: they carry their own ID.

## Behavioral changes — compression and archives

- **DeflateStream / GZipStream write headers and footers for an empty payload.** Code
  that tests `output.Length == 0` to mean "nothing compressed" must count the
  uncompressed bytes instead.
- **ZipArchive validates CRC32 when reading entries.** Corrupt or truncated archives
  now throw `InvalidDataException`; catch it where partial archives are expected.
- **ZipArchive.CreateAsync loads entries eagerly.** Memory grows with the entry count of
  large archives.
- **TAR readers verify header checksums.** Hand-crafted or corrupt TAR files now throw.
- **TarWriter emits `HardLink` entries** for an inode seen twice. Readers of archives
  produced by .NET must handle `TarEntryType.HardLink`.
- **PackagePart.GetStream() returns a non-seekable stream** for compressed parts of a
  package opened ReadWrite (System.IO.Packaging / OPC). Copy to a `MemoryStream` before
  seeking.
- Zstandard (`ZstandardStream`) is in-box in `System.IO.Compression`: drop the
  `System.IO.Compression.Zstandard` preview package (dotnet/runtime#114545).

## Behavioral changes — numbers, dates, parsing

- **`DateOnly`/`TimeOnly` `TryParse`/`TryParseExact` throw `ArgumentException` for an
  invalid `DateTimeStyles` value or format specifier** (they returned `false`). A
  malformed input *string* still returns `false`. Fix the argument at its source rather
  than catching the exception.
- **`Math.Round` / `MathF.Round` (with digits) return correctly rounded results.** Tests
  pinning the old, slightly wrong values must be updated, not the code.
- **Decimal and BigInteger floating-point conversions are correctly rounded.**
- **Complex special values (infinities, NaN) follow C23 Annex G.**
- **Tensor operations** align equivalent shapes and empty tensors, and reject
  unsupported storage layouts (`System.Numerics.Tensors`).
- **CborReader / CborWriter enforce a default maximum nesting depth.** Deeply nested
  CBOR now throws; raise the limit through the reader/writer options when legitimate.
- **Japanese calendar minimum supported date corrected.**

## Behavioral changes — process, OS, files

- **Named mutexes default to user scope on Unix.** For a mutex shared across users, pass
  `NamedWaitHandleOptions.None` (`new Mutex(false, "Name", NamedWaitHandleOptions.None)`)
  or set the runtime option `System.Threading.Mutex.UnsafeDefaultMutexScopeGlobal=true`.
  In a container running as a UID with no user-database entry (`docker run -u <uid>`,
  Kubernetes `runAsUser`) creating a named mutex now fails: set `XDG_RUNTIME_DIR` to a
  writable directory owned by that UID, or create the user in the image.
- **`NamedPipeServerStream` with `PipeOptions.CurrentUserOnly` tightens the Unix socket
  file permissions.**
- **`SafeFileHandle.IsAsync` / `FileStream.IsAsync` reflect the real non-blocking state
  on Unix.**
- **`Environment.GetCommandLineArgs()[0]` keeps the apphost invocation name.** Code
  deriving paths from it should use `Environment.ProcessPath` / `AppContext.BaseDirectory`.
- **`Environment.TickCount` made consistent with Windows timeout behavior.**
- **`Assembly.GetCallingAssembly` changes when stack-trace support is disabled**
  (trimmed/AOT apps with `StackTraceSupport=false`).
- **`Nullable.GetUnderlyingType` throws for custom `Type` subclasses.**
- **Generated WMI collection and enumerator wrappers implement `IDisposable`**
  (`System.Management`): dispose them; analyzers may flag existing code.

## Not in this file

`BackgroundService`, configuration and options changes are in
`extensions-dotnet10to11.md`; floating-point → small-integer conversions in
`runtime-jit-dotnet10to11.md`.
