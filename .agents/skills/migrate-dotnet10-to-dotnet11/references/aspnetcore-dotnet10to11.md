# ASP.NET Core 11 breaking changes

Official list: https://learn.microsoft.com/aspnet/core/breaking-changes/11/overview
(snapshot 2026-11-07, 20 entries). Each entry links to an article with the fix; read it
when the project uses the area and the line below is not enough.

## Removed APIs (source and binary incompatible)

- **MVC compatibility options removed (Preview 7).** `SetCompatibilityVersion`,
  `CompatibilityVersion`, `MvcCompatibilityOptions`, `ConfigureCompatibilityOptions<T>`
  were no-ops since 3.0. Delete the calls:
  ```csharp
  services.AddMvc();   // was: services.AddMvc().SetCompatibilityVersion(CompatibilityVersion.Latest);
  ```
  Binaries still referencing them fail with `MissingMethodException` / `TypeLoadException`:
  upgrade those libraries.
- **ConcurrencyLimiter middleware removed** (`Microsoft.AspNetCore.ConcurrencyLimiter`,
  `UseConcurrencyLimiter`). Use the rate-limiting middleware
  (`builder.Services.AddRateLimiter(o => o.AddConcurrencyLimiter(...))` +
  `app.UseRateLimiter()`), available since .NET 7.
- **Obsolete Blazor APIs removed**, **obsolete `ImageTagHelper` members removed**, and
  the obsolete **`ModelMetadataIdentity.ForProperty` overload removed**: switch to the
  replacement each `[Obsolete]` message named on .NET 10 (build on `net10.0` first to
  see the messages).

## OpenAPI

- **Microsoft.OpenApi upgraded to 3.x (source incompatible).** Only code that touches
  the object model (`OpenApiDocument`, `OpenApiSchema`, `OpenApiOperation`, document /
  operation / schema transformers) breaks; `AddOpenApi()` / `MapOpenApi()` alone does not.
  Follow https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-3.md.
- **`OpenApiVersion` defaults to OpenAPI 3.2.** Clients or gateways that only accept
  3.0/3.1 need `builder.Services.AddOpenApi(o => o.OpenApiVersion =
  Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1);`.
- The document now lists **every `ProducesResponseType` for a status code**, and the
  **server URL has no trailing slash when `PathBase` is empty**: snapshot tests of the
  generated document need updating.

## Behavioral changes

- **Kestrel tightens HTTP protocol compliance**: malformed requests some clients or
  proxies send may now be rejected (400). Test the real clients.
- **Hosting emits OpenTelemetry HTTP semantic-convention tags by default**: dashboards
  and alerts keyed on the old tag names need updating.
- **Response compression always emits `Vary: Accept-Encoding`** (affects cache keys).
- **HttpSys exposes the TLS channel-binding token by default.**
- **Passkey sign-in enforces email/phone confirmation and lockout** (ASP.NET Core
  Identity): unconfirmed accounts can no longer sign in with a passkey.
- **SqlClient Active Directory authentication moved to a separate package**: add
  `Microsoft.Data.SqlClient.Extensions.Azure` when using Entra ID (see `efcore`).

## Blazor

- **Custom event registration throws when its name matches a browser event.** Rename it.
- **Enhanced navigation no longer preloads resources.**
- **Server-side rendering defers antiforgery validation to the middleware**: keep
  `app.UseAntiforgery()` in the pipeline, in the documented position.
- **`WebAssemblyHostBuilder` loads environment variables into `IConfiguration`.**
- **QuickGrid sorting and pagination controls render as links** (CSS/selectors in UI
  tests).
- **`Virtualize<TItem>` default `OverscanCount` is 15 (was 3)**; set it explicitly where
  rendering cost matters. QuickGrid keeps 3. (dotnet/aspnetcore#64964)
