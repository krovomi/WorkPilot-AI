/**
 * The scanner that shows a generation while it is still being generated.
 *
 * What is pinned here is the one property the UI rests on: a file is reported
 * only once it is *complete*. Everything else — how the text is chopped into
 * chunks, whether the model pretty-prints, what it puts after the array — is
 * the model's business and must not change the answer.
 */

import { describe, expect, it } from "vitest";
import { GeneratedFileStream } from "../visual-programming-stream";

/** Feed a document one character at a time: the worst chunking there is. */
function pushByCharacter(stream: GeneratedFileStream, text: string) {
	const files = [];
	for (const char of text) files.push(...stream.push(char).files);
	return files;
}

const TWO_FILES = JSON.stringify({
	files: [
		{ filename: "src/App.tsx", language: "typescript", content: "export {};\n" },
		{ filename: "api/Program.cs", language: "csharp", content: "// entry\n" },
	],
	summary: "Two files",
	instructions: "Run it",
});

describe("GeneratedFileStream", () => {
	it("reports each file as its own object closes", () => {
		const stream = new GeneratedFileStream();
		const openingAndFirstFile = TWO_FILES.slice(0, TWO_FILES.indexOf("},") + 1);

		const first = stream.push(openingAndFirstFile);
		expect(first.files.map((f) => f.filename)).toEqual(["src/App.tsx"]);

		const rest = stream.push(TWO_FILES.slice(openingAndFirstFile.length));
		expect(rest.files.map((f) => f.filename)).toEqual(["api/Program.cs"]);
	});

	it("gives the same files however the text is chopped", () => {
		expect(
			pushByCharacter(new GeneratedFileStream(), TWO_FILES).map(
				(f) => f.filename,
			),
		).toEqual(["src/App.tsx", "api/Program.cs"]);

		expect(
			new GeneratedFileStream().push(TWO_FILES).files.map((f) => f.filename),
		).toEqual(["src/App.tsx", "api/Program.cs"]);
	});

	it("never reports a file whose content is still arriving", () => {
		const stream = new GeneratedFileStream();
		const half = TWO_FILES.slice(0, TWO_FILES.indexOf("export"));

		expect(stream.push(half).files).toEqual([]);
	});

	it("names the file being written before it is complete", () => {
		const stream = new GeneratedFileStream();
		const upToContent = TWO_FILES.slice(0, TWO_FILES.indexOf("export"));

		expect(stream.push(upToContent).writing).toBe("src/App.tsx");
	});

	it("is not fooled by braces and brackets inside content", () => {
		const document = JSON.stringify({
			files: [
				{
					filename: "a.ts",
					language: "typescript",
					// The three things that break a naive brace counter: an unbalanced
					// brace in a string, an escaped quote, and a closing bracket.
					content: 'const x = "{"; // ] and \\" inside\n',
				},
			],
			summary: "",
			instructions: "",
		});

		const files = pushByCharacter(new GeneratedFileStream(), document);
		expect(files).toHaveLength(1);
		expect(files[0].content).toBe('const x = "{"; // ] and \\" inside\n');
	});

	it("stops at the end of the array, not at the end of the document", () => {
		// `summary` is an object here, which a scanner that kept looking for
		// `{...}` past the `]` would happily report as a file.
		const document =
			'{"files": [{"filename":"a.ts","language":"ts","content":"x"}], "summary": {"text": "done"}}';

		expect(pushByCharacter(new GeneratedFileStream(), document)).toHaveLength(1);
	});

	it("reports nothing at all until the files key arrives", () => {
		const stream = new GeneratedFileStream();

		expect(stream.push('{"summary": "thinking about it"').files).toEqual([]);
		expect(stream.push(', "files": [').files).toEqual([]);
	});

	it("skips an entry that is not a file rather than dropping the rest", () => {
		const document =
			'{"files": [{"note":"no filename"},{"filename":"b.ts","language":"ts","content":"y"}]}';

		expect(
			pushByCharacter(new GeneratedFileStream(), document).map(
				(f) => f.filename,
			),
		).toEqual(["b.ts"]);
	});

	it("fills in a missing language rather than refusing the file", () => {
		const document = '{"files": [{"filename":"b.txt","content":"y"}]}';
		const [file] = pushByCharacter(new GeneratedFileStream(), document);

		expect(file).toEqual({ filename: "b.txt", language: "", content: "y" });
	});
});
