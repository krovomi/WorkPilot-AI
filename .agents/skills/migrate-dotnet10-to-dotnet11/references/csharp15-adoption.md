# Using C# 15 on .NET 11

Official page: https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-15 (snapshot
2026-11-07). C# 15 is the default language version of `net11.0`: no `<LangVersion>` is
needed, and setting one lower blocks these features.

Adopt after the migration builds and passes its tests, in its own change, and only
where a feature makes the code simpler or safer — not as a rewrite.

## Where C# 15 can be used

- `net11.0` projects: everything below.
- Multi-targeted libraries (`net10.0;net11.0`): `net10.0` compiles as C# 14. Keep shared
  code C# 14, or isolate C# 15 code behind `#if NET11_0_OR_GREATER`. Forcing
  `<LangVersion>15</LangVersion>` on `net10.0` is unsupported.
- `<LangVersion>preview</LangVersion>` brings C# 16 previews and their breaking changes
  (see `csharp-compiler`): not for production.

## Features

### Union types

```csharp
public record class Cat(string Name);
public record class Dog(string Name);
public union Pet(Cat, Dog);

Pet pet = new Dog("Rex");             // implicit conversion from each case type
string name = pet switch              // exhaustive: no default arm, a warning if a case is missing
{
    Dog d => d.Name,
    Cat c => c.Name,
};
```

Good fit: results and outcomes inside the domain/application layers
(`union CreateOrderResult(OrderCreated, ValidationFailed, OutOfStock)`), replacing
`OneOf`-style packages or exception-driven flow. Before exposing a union at a boundary
(API contract, message, EF entity, cache), test how the serializer or mapper handles it;
map to explicit DTOs there when in doubt.

### Closed hierarchies

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

string Describe(GateState s) => s switch { Closed => "closed", Open(var p) => $"{p}% open" };
```

`closed` limits direct derivation to the declaring assembly, so a `switch` over the
direct descendants is exhaustive. A closed class is implicitly abstract (no `sealed`,
`static` or explicit `abstract`), and closedness is not transitive: mark intermediate
classes `closed` too. Adding `closed` to a public type of a published library breaks
consumers that derive from it.

### Collection expression arguments

```csharp
List<string> names = [with(capacity: values.Length * 2), .. values];
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO"];
```

Pass capacity, comparers or factory arguments without leaving collection-expression
syntax. A method named `with` must now be called as `@with(...)` inside a collection
expression.

### Extension indexers

```csharp
public static class SequenceIndexer
{
    extension(IEnumerable<int> sequence)
    {
        public int this[int index] => sequence.ElementAt(index);
    }
}
```

Completes C# 14 `extension` blocks. Mind hidden costs: an indexer that enumerates is
O(n) per call.

### Labeled `break` and `continue`

```csharp
outer: for (int row = 0; row < grid.Height; row++)
    for (int col = 0; col < grid.Width; col++)
    {
        if (grid[row, col].IsBlocked) continue outer;
        if (grid[row, col].IsGoal) break outer;
    }
```

Replaces flag variables and `goto` in nested loops; the label goes directly on the loop
or `switch`. IDE0410 suggests the rewrite.

### Non-virtual static interface members on older runtimes

Interfaces can declare and use non-virtual `static` members even where the runtime has
no default-interface-method support. Instance default implementations, `static
abstract`/`static virtual` and protected members still need runtime support.

### Memory safety rules (preview — do not adopt)

The new `unsafe` rules (`unsafe(expr)`, `safe` keyword, *requires-unsafe* members) need
`<LangVersion>preview</LangVersion>` and a feature flag. Leave them out of production
code until they ship.

## Checklist when adopting

1. One feature per change; keep the tests green between them.
2. `dotnet format` and the analyzers (IDE0410, nullable warnings) stay clean.
3. Public API surface: a union or a `closed` type in a published package is a contract
   change — version it.
