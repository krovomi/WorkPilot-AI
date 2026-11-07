# EF Core 11 breaking changes

Official list: https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes
(snapshot 2026-11-07). Ordered by impact.

## All providers

- **No migrations found now throws.** `Migrate()` / `MigrateAsync()` with no migration in
  the assembly throws. Remove the call, or
  `options.ConfigureWarnings(w => w.Ignore(RelationalEventId.MigrationsNotFound))`.
- **Split queries throw on concurrent modification**: `DbQueryConcurrencyException`
  instead of silently empty collections. Retry, use a snapshot/serializable
  transaction, or `AsSingleQuery()`.
- **`Property()` no longer configures primitive collections**: use
  `modelBuilder.Entity<Blog>().PrimitiveCollection(b => b.Tags);`.
- **Owned JSON collections without a key are obsolete**
  (`OwnedEntityMappedToJsonCollectionWarning`): move to
  `ComplexCollection(b => b.Posts, b => b.ToJson())`, or add `HasKey`.
- **`EFOptimizeContext` removed**: use `<EFScaffoldModelStage>` and
  `<EFPrecompileQueriesStage>` (`publish`). With `PublishAot=true` it is automatic.
- **Tools/Tasks packages no longer reference `.Design`**:
  `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />`.

## SQL Server

- **Microsoft.Data.SqlClient 7.0** (medium): Entra ID authentication left the core
  package — add `Microsoft.Data.SqlClient.Extensions.Azure` (7.0.0) when the connection
  string uses `Active Directory *`; `ActiveDirectoryPassword` is obsolete, move to
  `ActiveDirectoryDefault` or `ActiveDirectoryInteractive`.
- **Compatibility level defaults to 160** (SQL Server 2022: `LEAST`/`GREATEST`…). On an
  older server: `UseSqlServer(cs, o => o.UseCompatibilityLevel(150))`.
- **`SqlVector<T>` properties are not loaded by default** (left out of `SELECT`, `null`
  on entities); still usable in `WHERE`/`ORDER BY`. Project them explicitly.

## SQLite (Microsoft.Data.Sqlite 11)

- **Targets `net10.0`+ only: no .NET Framework.** A Framework project stays on 10.0.x.
- **SQLitePCLRaw 3: `bundle_e_sqlcipher`, `bundle_sqlite3`, `bundle_winsqlite3`,
  `bundle_green`, `bundle_e_sqlite3mc` are gone.** Encryption: `SQLite3MC.PCLRaw.bundle`,
  SQLCipher (Zetetic) or SEE; system SQLite: `SQLitePCLRaw.provider.sqlite3` /
  `.provider.winsqlite3` plus `SQLitePCL.raw.SetProvider(...)`.
- **No UWP or classic Xamarin native builds.**

## Azure Cosmos DB provider

- **High — unmapped properties are no longer preserved**: JSON properties absent from
  the model are lost on the next save. Map them, or use `CosmosClient` directly.
- **Sync I/O fully removed**: `ToList()`, `First()`, `Count()`, `SaveChanges()`… always
  throw. Use the `…Async` equivalents.
- **Projection that evaluates to undefined throws**: filter with
  `EF.Functions.IsDefined(...)` or use `EF.Functions.CoalesceUndefined(...)`.
- **Illegal `id` characters (`/ \ ? #`) are no longer escaped**: existing documents may
  no longer be found; `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)`
  keeps the old behavior.
- `__jObject` shadow property removed (read raw JSON with
  `GetCosmosClient()` + `ReadItemAsync<JsonElement>`); empty owned collections are empty,
  not `null`; the discriminator property is named `Discriminator` in the model (JSON
  name `$type` unchanged); floating-point values are truncated, not rounded, into
  fixed-point types.
