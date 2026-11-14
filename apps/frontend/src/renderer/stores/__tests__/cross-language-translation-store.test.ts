/**
 * WLangage in the translation page is a source only: nothing outside the
 * WinDev editor can create the element a translation into it would go in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useCrossLangTranslationStore } from "../cross-language-translation-store";

describe("cross-language translation store", () => {
	beforeEach(() => {
		useCrossLangTranslationStore.setState({
			sourceLang: "python",
			targetLang: "typescript",
			outputCode: "",
		});
	});

	it("offers WLangage as a source", () => {
		const { languages, setSourceLang } = useCrossLangTranslationStore.getState();
		expect(languages.find((lang) => lang.id === "wlangage")?.sourceOnly).toBe(true);
		setSourceLang("wlangage");
		expect(useCrossLangTranslationStore.getState().sourceLang).toBe("wlangage");
	});

	it("never makes WLangage the target, by choice or by swap", () => {
		const store = useCrossLangTranslationStore.getState();
		store.setTargetLang("wlangage");
		expect(useCrossLangTranslationStore.getState().targetLang).toBe("typescript");
		store.setSourceLang("wlangage");
		useCrossLangTranslationStore.getState().swapLanguages();
		const after = useCrossLangTranslationStore.getState();
		expect(after.sourceLang).toBe("wlangage");
		expect(after.targetLang).toBe("typescript");
	});
});
