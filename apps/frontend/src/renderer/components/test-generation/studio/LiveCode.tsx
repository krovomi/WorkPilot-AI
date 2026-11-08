import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

/**
 * The generated test file as it streams in: line numbers, a light syntax
 * colouring that works for every language the generator writes (keywords of
 * C#, Java, Kotlin, Go, Rust, PHP, Ruby, Swift, Dart, Python, JS/TS, C/C++),
 * and a typewriter easing so a provider that answers in one block still reads
 * as being written.
 */

const KEYWORDS = new Set(
	(
		"using namespace public private protected internal class interface struct enum record void var val let mut new return null nil None true false True False this self base super async await if else elif for foreach while do switch case match when break continue throw throws try catch except finally get set static readonly const final import from export default function func fn def assert lambda pass raise yield with as in is not and or package impl trait pub use mod extends implements override sealed data object fun suspend guard defer go chan select type require require_once describe it test expect before after beforeEach afterEach setUp tearDown"
	).split(" "),
);

interface Tok {
	t: string;
	c: string;
}

const TOKEN_RE =
	/(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\[[A-Za-z@][\w.]*\]?|@[A-Za-z_]\w*|#\[[^\]]*\])|([A-Za-z_$]\w*)|(\d[\d._]*)|(\s+)|([^\w\s]+)/g;

export function tokenize(line: string): Tok[] {
	if (line.length > 2000) return [{ t: line, c: "tg-tok-text" }];
	const out: Tok[] = [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TOKEN_RE.exec(line);
	while (m !== null) {
		if (m[1]) out.push({ t: m[1], c: "tg-tok-comment" });
		else if (m[2]) out.push({ t: m[2], c: "tg-tok-string" });
		else if (m[3]) out.push({ t: m[3], c: "tg-tok-attr" });
		else if (m[4])
			out.push({
				t: m[4],
				c: KEYWORDS.has(m[4])
					? "tg-tok-keyword"
					: /^[A-Z]/.test(m[4])
						? "tg-tok-type"
						: "tg-tok-text",
			});
		else if (m[5]) out.push({ t: m[5], c: "tg-tok-number" });
		else if (m[6]) out.push({ t: m[6], c: "" });
		else if (m[7]) out.push({ t: m[7], c: "tg-tok-punct" });
		m = TOKEN_RE.exec(line);
	}
	return out;
}

function useTypewriter(target: string, animate: boolean): string {
	const [revealed, setRevealed] = useState("");
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		if (!animate) {
			setRevealed(target);
			return;
		}
		let raf = 0;
		const loop = () => {
			setRevealed((cur) => {
				const full = targetRef.current;
				if (cur.length >= full.length) return full;
				const remaining = full.length - cur.length;
				const step = Math.max(4, Math.ceil(remaining / 6));
				return full.slice(0, cur.length + step);
			});
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [animate, target]);

	return animate ? revealed : target;
}

interface LiveCodeProps {
	readonly code: string;
	readonly streaming: boolean;
	/** What to show while nothing has arrived. */
	readonly placeholder: ReactNode;
}

export function LiveCode({ code, streaming, placeholder }: LiveCodeProps) {
	const prefersReduced = useMemo(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
		[],
	);
	const revealed = useTypewriter(code, streaming && !prefersReduced);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Follow the text as it grows: the length is the only thing that moves.
	const shown = revealed.length;
	useEffect(() => {
		const el = scrollRef.current;
		if (el && streaming && shown > 0) el.scrollTop = el.scrollHeight;
	}, [shown, streaming]);

	if (!revealed) {
		return <div className="tg-code-empty">{placeholder}</div>;
	}

	// Lines and tokens are positional: their place in the file is their key.
	const rows = revealed.split("\n").map((text, n) => ({
		n: n + 1,
		tokens: tokenize(text).map((tok, k) => ({ ...tok, k })),
	}));
	return (
		<div ref={scrollRef} className="tg-code-scroll" data-testid="test-studio-code">
			<pre>
				{rows.map((row) => (
					<div key={row.n} className="tg-code-line">
						<span className="tg-code-gutter">{row.n}</span>
						<span className="tg-code-text">
							{row.tokens.map((tok) => (
								<span key={tok.k} className={tok.c}>
									{tok.t}
								</span>
							))}
							{streaming && row.n === rows.length && <span className="tg-caret" />}
						</span>
					</div>
				))}
			</pre>
		</div>
	);
}

/** Line count of the code shown, for the stats strip. */
export function lineCount(code: string): number {
	return code ? code.split("\n").length : 0;
}
