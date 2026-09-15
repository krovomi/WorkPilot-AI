import { afterEach, expect, it, vi } from "vitest";
import { getStaticProviders } from "../providers";

afterEach(() => vi.unstubAllGlobals());

it("includes Claude authenticated through CLI OAuth without a saved API key", async () => {
  vi.stubGlobal("electronAPI", { checkClaudeOAuth: vi.fn().mockResolvedValue({ isAuthenticated: true }) });
  const settings = {};
  const result = await getStaticProviders([], settings);
  expect(result.status.anthropic).toBe(true);
  expect(settings).toEqual({});
});
it("includes OpenAI authenticated through Codex even if Claude detection fails", async () => {
  vi.stubGlobal("electronAPI", {
    checkClaudeOAuth: vi.fn().mockRejectedValue(new Error("unavailable")),
    checkOpenAICodexOAuth: vi.fn().mockResolvedValue({ isAuthenticated: true }),
  });
  const result = await getStaticProviders([], {});
  expect(result.status.openai).toBe(true);
  expect(result.status.anthropic).toBe(false);
});
it("keeps API key configuration available without desktop IPC", async () => {
  vi.stubGlobal("electronAPI", undefined);
  const result = await getStaticProviders([], { globalAnthropicApiKey: "test-key" });
  expect(result.status.anthropic).toBe(true);
  expect(result.status.openai).toBe(false);
});
