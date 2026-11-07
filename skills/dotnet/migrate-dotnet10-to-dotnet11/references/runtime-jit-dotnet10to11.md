# Runtime, JIT, interop, deployment and networking changes (.NET 11)

Official articles under https://learn.microsoft.com/dotnet/core/compatibility/11
(JIT, Interop, Deployment, Networking; snapshot 2026-11-07).

## Minimum hardware (high impact on old machines)

.NET 11 refuses to start on a CPU below the baseline, printing
"The current CPU is missing one or more of the baseline instruction sets."

| OS | x86/x64 minimum (JIT/AOT) | x64 ReadyToRun target | Arm64 minimum | Arm64 R2R target |
|---|---|---|---|---|
| Windows | x86-64-v1 → **x86-64-v2** | x86-64-v2 → **x86-64-v3** | armv8.0-a → **armv8.0-a + LSE** | → **armv8.2-a + RCPC** |
| Linux | x86-64-v1 → **x86-64-v2** | x86-64-v2 → **x86-64-v3** | armv8.0-a (unchanged, Raspberry Pi OK) | → armv8.0-a + LSE |
| Apple | x86-64-v1 → **x86-64-v2** | unchanged | Apple M1 (unchanged) | unchanged |

x86-64-v2 adds CX16, POPCNT, SSE3, SSSE3, SSE4.1, SSE4.2: any Intel/AMD CPU from about
2013 on. Hardware meeting v2 but not v3 (no AVX2/BMI/FMA) runs, with extra JIT work at
startup. Check build agents, on-premises servers, VMs with a restricted CPU model
(QEMU/KVM `qemu64`, some hypervisors) and embedded devices.

## JIT

- **Floating-point → small integral conversions saturate.** `(byte)300.0` is `255`,
  `(sbyte)-200.0` is `-128`, NaN is `0` — on every platform, where results used to vary.
  Code relying on wrap-around must do it explicitly (`(byte)(int)value`).

## Interop and NativeAOT

- **NativeAOT rejects non-blittable `[UnmanagedCallersOnly]` signatures.** Use blittable
  parameter types (pointers, `int`, `IntPtr`, blittable structs) and marshal manually.
- **NativeAOT native-library outputs on Linux/macOS get the `lib` prefix**
  (`libMyLib.so`, `libMyLib.dylib`): update scripts, packaging and `DllImport` names that
  used the old file name.

## Deployment

- **`configProperties` in `.runtimeconfig.dev.json` override `.runtimeconfig.json`.**
  Dev-only settings now win locally: keep production switches out of the dev file.

## Networking

- **`HttpClient` high-cardinality metrics use observable counters**: exporters and
  dashboards reading those instruments may need their queries updated.
- **`SslStream` server-side AIA downloads are off by default** — see `cryptography`.
