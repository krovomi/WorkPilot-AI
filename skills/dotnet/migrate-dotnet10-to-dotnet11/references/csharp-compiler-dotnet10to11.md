# C# 15 compiler breaking changes (.NET 11 SDK)

The Roslyn shipped with the .NET 11 SDK; `net11.0` defaults to C# 15. Official list:
https://learn.microsoft.com/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2011
(snapshot 2026-11-07). Most of these also appear with Visual Studio 2026 18.3+ on a
.NET 10 project, so a pre-existing warning may already point at one.

## Apply to every project

### `closed` is a contextual keyword in type declarations (C# 15)

A type or alias named `closed` reports CS9380; in a member declaration, `closed Foo;`
is now read as a modifier (CS1519).

```csharp
class C
{
    closed oldField;      // C# 14: field of type 'closed'; C# 15: incomplete declaration
    @closed currentField; // fix: escape the identifier
}
```

### `union` is a contextual keyword in type declarations (C# 15)

`union` followed by a name can now parse as a union declaration (CS9370).

```csharp
class C
{
    union OldField;      // C# 15: union declaration
    @union CurrentField; // fix
}
```

### `with(...)` as a collection-expression element is constructor arguments (C# 15)

```csharp
items = [with(x, y), z];   // C# 14: calls a method named with; C# 15: error for object[]
items = [@with(x, y), z];  // fix: escape to call the method
```

### Span/ReadOnlySpan collection expressions: safe-context is `declaration-block`

```csharp
scoped Span<int> items1 = default;
foreach (var x in new[] { 1, 2 })
{
    Span<int> items = [x];
    if (x == 1) items1 = items;   // now an error
}
```

Fix: use an array (`int[] items = [x];`), or declare the span outside the loop and
assign its elements (`items[0] = x;`).

### `nameof(this.X)` / `nameof(base.X)` in attributes is disallowed

Allowed by mistake since C# 12. Write `nameof(X)`.

### `ref readonly` synthesized delegates and local functions need `InAttribute`

`var d = this.MethodWithRefReadonlyReturn;`, `ref readonly int () => ref x`, or a
`ref readonly` local function report CS0518 when
`System.Runtime.InteropServices.InAttribute` is unavailable. Only custom/minimal
reference sets hit this; reference an assembly that defines it.

### Dynamic `&&` / `||` with an interface-typed left operand

`I1 x = …; dynamic y = …; _ = x && y;` is now CS7083 at compile time (it used to throw
`RuntimeBinderException`). Cast the left operand: `(C1)x && y` or `(dynamic)x && y`.

### `(X.Y) when` in a switch-expression arm

Now parsed as the constant pattern `(X.Y)` followed by a `when` clause, no longer as a
cast of an identifier named `when`. Review switch arms that relied on the old parse.

## Only with `<LangVersion>preview</LangVersion>` (C# 16 previews)

Not part of C# 15. Listed so a project that sets `preview` knows why it breaks:

- pointer types no longer need `unsafe`: overload resolution sees more candidates, new
  CS0121 ambiguities (`M(x => { })` between `F1(int*)` and `F2(int)`); give the lambda
  explicit parameter types;
- `safe` becomes a contextual modifier keyword: escape a type named `safe` as `@safe`;
- calls to some pointer-taking members outside `unsafe` report CS9363: wrap them in
  `unsafe { }` or `unsafe(expr)`.

Recommendation: keep the default language version (C# 15) for the migration; do not
set `preview` in production code.
