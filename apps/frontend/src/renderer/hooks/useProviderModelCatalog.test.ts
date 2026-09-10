import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProviderModelCatalog } from "./useProviderModelCatalog";
afterEach(() => vi.unstubAllGlobals());
it("does not retain previous-provider live models while the new catalog loads", async () => {
 const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ models: [{ value: "old-local-model", label: "Old local" }], source: "live" }) }).mockImplementation(() => new Promise(() => { /* Keep the next provider request pending. */ }));
 vi.stubGlobal("fetch", fetchMock);
 const { result, rerender } = renderHook(({ provider }) => useProviderModelCatalog(provider), { initialProps: { provider: "ollama" } });
 await waitFor(() => expect(result.current.models.some(m => m.value === "old-local-model")).toBe(true));
 act(() => rerender({ provider: "anthropic" }));
 expect(result.current.models.some(m => m.value === "old-local-model")).toBe(false);
});
