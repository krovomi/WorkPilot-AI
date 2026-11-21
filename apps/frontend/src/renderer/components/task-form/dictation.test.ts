import { describe, expect, it } from "vitest";
import { appendDictation, appendTranscript } from "./dictation";

describe("dictation without overwriting typing", () => {
	it("appends new speech to the latest manually corrected draft", () => {
		expect(
			appendTranscript("Créer une facture Cegid.", "Puis l’envoyer."),
		).toBe("Créer une facture Cegid. Puis l’envoyer.");
	});
	it("preserves the current description and keeps it for an exact undo", () => {
		const edit = appendDictation(
			"Typed while recording",
			"Überprüfung mañana",
			false,
		);
		expect(edit.after).toBe("Typed while recording\n\nÜberprüfung mañana");
		expect(edit.before).toBe("Typed while recording");
	});
	it("escapes spoken markup when inserting into a rich description", () => {
		expect(
			appendDictation("<p>Existing</p>", "<script> & café\nHallo", true).after,
		).toBe("<p>Existing</p><p>&lt;script&gt; &amp; café<br>Hallo</p>");
	});
	it("ignores silence and joins phrases with a single space", () => {
		expect(appendTranscript("Déjà là", "   ")).toBe("Déjà là");
		expect(appendTranscript("", " Bonjour ")).toBe("Bonjour");
		expect(appendTranscript("Ligne\n", "suite")).toBe("Ligne\nsuite");
	});
	it("leaves the description alone when the draft is empty", () => {
		expect(appendDictation("Kept", "  ", false)).toEqual({
			before: "Kept",
			after: "Kept",
		});
		expect(appendDictation("", "First words", false).after).toBe("First words");
	});
});
