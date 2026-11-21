import { describe, expect, it } from "vitest";
import { readConfirmation, readStopCommand } from "../voice-stop";

describe("the spoken stop", () => {
	it.each([
		"Stop",
		"stop !",
		"Arrête tout",
		"Arrête-toi",
		"arrêtez les agents maintenant",
		"Attends",
		"stop the agents now please",
		"Halt",
		"Para todo",
		"Stopp jetzt",
		"Fermati",
	])("« %s » stops", (said) => {
		expect(readStopCommand(said)).toBe(true);
	});

	it.each([
		"",
		"stop the server from caching",
		"arrête de mettre des espaces",
		"ouvre le kanban",
		"stop stop stop stop stop stop",
		"tout",
	])("« %s » does not", (said) => {
		expect(readStopCommand(said)).toBe(false);
	});
});

describe("yes or no", () => {
	it.each([
		["Oui", "yes"],
		["oui vas-y", "yes"],
		["yes please", "yes"],
		["OK", "yes"],
		["Ja", "yes"],
		["Non", "no"],
		["non annule", "no"],
		["no", "no"],
		["Cancel", "no"],
		["Nein", "no"],
	])("« %s » is %s", (said, answer) => {
		expect(readConfirmation(said)).toBe(answer);
	});

	it.each(["", "oui mais ajoute un test", "oui non", "please", "yes yes yes yes yes yes"])(
		"« %s » is no answer",
		(said) => {
			expect(readConfirmation(said)).toBeNull();
		},
	);
});
