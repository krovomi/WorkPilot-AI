import { describe, expect, it } from "vitest";
import { appendDictation, appendTranscript, undoDictation } from "./dictation";

describe("dictation without overwriting typing", () => {
	it("appends new speech to the latest manually corrected draft", () => {
		expect(
			appendTranscript("Créer une facture Cegid.", "Puis l’envoyer."),
		).toBe("Créer une facture Cegid. Puis l’envoyer.");
	});
	it("preserves the current description and allows an exact undo", () => {
		const edit = appendDictation(
			"Typed while recording",
			"Überprüfung mañana",
			false,
		);
		expect(edit.after).toBe("Typed while recording\n\nÜberprüfung mañana");
		expect(undoDictation(edit.after, edit)).toBe(edit.before);
		expect(undoDictation(`${edit.after}!`, edit)).toBeNull();
	});
	it("escapes spoken markup when inserting into a rich description", () => {
		expect(
			appendDictation("<p>Existing</p>", "<script> & café\nHallo", true).after,
		).toBe("<p>Existing</p><p>&lt;script&gt; &amp; café<br>Hallo</p>");
	});
});
