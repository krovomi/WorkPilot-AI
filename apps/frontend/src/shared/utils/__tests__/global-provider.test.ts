import { expect, it } from "vitest";
import { buildGlobalProviderMetadataUpdate } from "../task-thinking";
import { getModelsForProvider } from "../../constants/models";

it("replaces all phase providers and old local models with the chosen provider models", () => {
 const update = buildGlobalProviderMetadataUpdate("openai", undefined);
 expect(update.provider).toBe("openai");
 expect(Object.values(update.phaseProviders)).toEqual(["openai", "openai", "openai", "openai"]);
 const allowed = getModelsForProvider("openai").map(m => m.value);
 for (const model of Object.values(update.phaseModels)) expect(allowed).toContain(model);
 expect(update.isAutoProfile).toBe(true);
});
it("uses the configured local model for every phase", () => {
 const update = buildGlobalProviderMetadataUpdate("ollama", { globalOllamaModel: "my-local:latest" } as never);
 expect(Object.values(update.phaseModels)).toEqual(Array(4).fill("my-local:latest"));
});
it("uses the model chosen on a gateway page for every phase", () => {
 const update = buildGlobalProviderMetadataUpdate("huggingface", { globalHuggingFaceModel: "zai-org/GLM-5.3-Flash", globalOllamaModel: "llama3.3" } as never);
 expect(Object.values(update.phaseModels)).toEqual(Array(4).fill("zai-org/GLM-5.3-Flash"));
});
it("keeps a gateway's own per-phase models over its page model", () => {
 const update = buildGlobalProviderMetadataUpdate("openrouter", {
  globalOpenRouterModel: "a/b",
  providerPhaseModels: { openrouter: { spec: "x/spec", planning: "x/plan", coding: "x/code", qa: "x/qa" } },
 } as never);
 expect(update.phaseModels).toEqual({ spec: "x/spec", planning: "x/plan", coding: "x/code", qa: "x/qa" });
});
