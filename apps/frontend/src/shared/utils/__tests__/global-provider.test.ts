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
