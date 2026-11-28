// The in-page half of the Browser Agent recorder (browser_agent/recorder.py).
//
// Runs in every frame of a page the person drives; it only describes what
// they do, through the `__workpilotRecord` binding. Python adds the frame's
// place in the page (it asks the parent frame to describe the <iframe>, with
// `__workpilotDescribe`). An element inside open shadow roots is described in
// its own root, with the hosts above it (`shadow`); an element the page
// inserted after the previous action says so (`appeared`), for the replay to
// wait for it. A value typed into a password field, or into a field named
// like a secret, is never sent: the report says `secret: true` instead.
// Each role, label, placeholder and text is counted in the element's root
// (`matches`), so a selector that is not unique keeps the element's place.
// After an action, a status, an alert or a heading that showed up is proposed
// as a check (`suggest`), and a loading indicator that showed and went away
// is reported (`settled`) by what it has, never by a selector of the page,
// whether the page inserted it or showed one it had (a class, `hidden`, a
// style, `aria-busy`). A hover is reported only when it showed something; a
// scroll the person made, once it rests; a drag with the element it was
// dropped on (drag events, or a pointer pressed on one element and released
// on another); a contenteditable as a typed value; every option picked in a
// multiple list. Shadow roots the parser attached (`<template shadowrootmode>`)
// are listened to once an event comes out of them.
// Everything sent is plain data that Python bounds and checks again.
(() => {
	if (window.__workpilotRecorder) return;
	window.__workpilotRecorder = true;

	const MAX = 200;
	const SECRET = /pass|pwd|secret|token|api[-_ ]?key|otp|cvc|cvv|\bpin\b/i;
	const SECRET_AUTOCOMPLETE = /password|one-time-code|cc-number|cc-csc/i;
	const TEST_ATTRS = ["data-test", "data-cy", "data-qa"];
	const TEXT_INPUTS = /^(|text|email|password|search|tel|url|number|date|time|datetime-local|month|week)$/;
	// Counting stops past this many candidates (the count is then not sent).
	const MAX_SCAN = 3000;
	const MAX_MATCHES = 20;
	// What may become a proposed check, once it shows after an action.
	const NOTABLE =
		'[role="alert"], [role="status"], [role="alertdialog"], [role="dialog"], [role="heading"], [aria-live="polite"], [aria-live="assertive"], output, h1, h2, h3';
	const LOADER =
		'[role="progressbar"], [aria-busy="true"], [class*="spin"], [class*="load"], [class*="skeleton"]';
	// The elements that may have a role implicitly, by role (any element may set it).
	const ROLE_TAGS = {
		button: "button, summary, input, ",
		link: "a[href], ",
		heading: "h1, h2, h3, h4, h5, h6, ",
		img: "img, ",
		option: "option, ",
		combobox: "select, ",
		listbox: "select, ",
	};
	const SUGGEST_AFTER_MS = 1000;
	const SETTLE_POLL_MS = 200;
	const SETTLE_FOR_MS = 15000;
	// Shadow hosts above an element, at most: deeper is not recorded.
	const MAX_DEPTH = 9;
	const HOVER_MS = 400;
	const SCROLL_REST_MS = 500;
	const DRAG_MIN_PX = 16;
	const SCROLL_KEYS = /^(PageDown|PageUp|ArrowDown|ArrowUp|Home|End| )$/;

	const send = (report) => {
		try {
			const binding = window.__workpilotRecord;
			if (typeof binding === "function") binding(report);
		} catch (_error) {
			// The binding is gone (the page is closing): nothing to record.
		}
	};

	const line = (value) =>
		typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX) : "";

	// The document, or the shadow root the element is in: selectors are unique there.
	const rootOf = (el) => {
		const root = el.getRootNode ? el.getRootNode() : document;
		return root && typeof root.querySelectorAll === "function" ? root : document;
	};

	const count = (root, selector) => {
		try {
			return root.querySelectorAll(selector).length;
		} catch (_error) {
			return 0;
		}
	};

	// The host of the open shadow root `node` is in, or null.
	const hostOf = (node) => {
		const root = node.getRootNode ? node.getRootNode() : null;
		return root && root !== document && root.host ? root.host : null;
	};

	// Elements the page inserted, by the number of actions sent before; what
	// the last action changed that may be checked, and the loaders it showed.
	let actions = 0;
	const inserted = new WeakMap();
	let changed = new Set();
	let loaders = new Set();
	const noteChange = (node) => {
		const el = node.nodeType === 1 ? node : node.parentElement;
		if (!el || changed.size >= 20) return;
		const notable = el.closest(NOTABLE);
		if (notable) changed.add(notable);
		if (node.nodeType !== 1) return;
		for (const inner of el.querySelectorAll(NOTABLE)) if (changed.size < 20) changed.add(inner);
		for (const loader of [el, ...el.querySelectorAll(LOADER)]) {
			if (loader.matches(LOADER) && loaders.size < 10) loaders.add(loader);
		}
	};
	// A loader the page had and now shows (a class, `hidden`, a style, `aria-busy`).
	const noteShown = (el) => {
		if (el.nodeType !== 1 || loaders.size >= 10) return;
		if (el.matches(LOADER)) loaders.add(el);
		for (const inner of el.querySelectorAll(LOADER)) if (loaders.size < 10) loaders.add(inner);
	};
	const observer = new MutationObserver((records) => {
		for (const record of records) noteHoverChange(record);
		if (!actions) return;
		for (const record of records) {
			if (record.type === "characterData") noteChange(record.target);
			if (record.type === "attributes") noteShown(record.target);
			for (const node of record.addedNodes) {
				if (node.nodeType === 1) inserted.set(node, actions);
				noteChange(node);
			}
		}
	});
	const OBSERVED = {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["class", "style", "hidden", "aria-busy"],
	};
	observer.observe(document, OBSERVED);

	const appeared = (el) => {
		for (let node = el; node; node = node.parentElement || hostOf(node)) {
			if (actions && inserted.get(node) === actions) return true;
		}
		return false;
	};

	const implicitRole = (el) => {
		const tag = el.tagName.toLowerCase();
		const type = (el.getAttribute("type") || "").toLowerCase();
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "a" && el.hasAttribute("href")) return "link";
		if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
		if (tag === "textarea") return "textbox";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "img" && el.getAttribute("alt")) return "img";
		if (tag === "option") return "option";
		if (tag !== "input") return "";
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (type === "search") return "searchbox";
		if (type === "number") return "spinbutton";
		if (type === "password") return "";
		return TEXT_INPUTS.test(type) ? "textbox" : "";
	};

	const textOf = (el) => line(el.innerText || el.textContent || "");

	const shows = (el) =>
		el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

	// How many elements of `root` give `same(candidate)`, and `el`'s place among them.
	const matchesOf = (root, css, el, same) => {
		let list;
		try {
			list = root.querySelectorAll(css);
		} catch (_error) {
			return null;
		}
		if (list.length > MAX_SCAN) return null;
		let count = 0;
		let index = -1;
		for (const candidate of list) {
			if (!same(candidate)) continue;
			if (candidate === el) index = count;
			count += 1;
			if (count > MAX_MATCHES) break;
		}
		return { count, index };
	};

	const labelOf = (el) => {
		const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
		if (ids.length) {
			const root = rootOf(el);
			const byId = (id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id));
			return line(ids.map((id) => textOf(byId(id) || document.body)).join(" "));
		}
		const labels = el.labels;
		if (labels && labels.length) return textOf(labels[0]);
		return "";
	};

	const nameOf = (el) => {
		const aria = line(el.getAttribute("aria-label") || "");
		if (aria) return aria;
		const label = labelOf(el);
		if (label) return label;
		const tag = el.tagName.toLowerCase();
		if (tag === "input") {
			const type = (el.getAttribute("type") || "").toLowerCase();
			if (["button", "submit", "reset"].includes(type)) return line(el.value || "");
			return line(el.getAttribute("title") || "");
		}
		if (tag === "img") return line(el.getAttribute("alt") || "");
		if (["select", "textarea"].includes(tag)) return line(el.getAttribute("title") || "");
		// What is typed into an editor is its value, never its name.
		if (el.isContentEditable) return line(el.getAttribute("title") || "");
		return textOf(el) || line(el.getAttribute("title") || "");
	};

	const segment = (el) => {
		const tag = el.tagName.toLowerCase();
		const parent = el.parentElement;
		if (!parent) return tag;
		const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
		return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
	};

	const cssPath = (el) => {
		const parts = [];
		const root = rootOf(el);
		let node = el;
		for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
			parts.unshift(segment(node));
			const selector = parts.join(" > ");
			if (count(root, selector) === 1) return selector;
			node = node.parentElement;
		}
		return "";
	};

	const isSecret = (el) => {
		const type = (el.getAttribute("type") || "").toLowerCase();
		if (type === "password") return true;
		if (SECRET_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "")) return true;
		return [el.getAttribute("name"), el.id, labelOf(el), el.getAttribute("placeholder")].some(
			(v) => typeof v === "string" && SECRET.test(v),
		);
	};

	const roleOf = (el) => line(el.getAttribute("role") || "").split(" ")[0] || implicitRole(el);

	// The text a getByText query matches: the innermost element holding it.
	const ownText = (el, text) =>
		line(el.textContent || "") === text &&
		!Array.from(el.children).some((child) => line(child.textContent || "") === text);

	const countMatches = (el, root, role, name, label, placeholder) => {
		const matches = {};
		if (role && name) {
			const css = `${ROLE_TAGS[role] || "input, textarea, "}[role]`;
			matches.role = matchesOf(root, css, el, (c) => roleOf(c) === role && nameOf(c) === name);
		}
		if (label) {
			matches.label = matchesOf(
				root,
				"input, select, textarea, [aria-labelledby], [aria-label]",
				el,
				(c) => labelOf(c) === label || line(c.getAttribute("aria-label") || "") === label,
			);
		}
		if (placeholder) {
			matches.placeholder = matchesOf(
				root,
				"[placeholder]",
				el,
				(c) => line(c.getAttribute("placeholder") || "") === placeholder,
			);
		}
		const text = el.isContentEditable ? "" : line(el.textContent || "");
		if (text && ownText(el, text)) matches.text = matchesOf(root, "*", el, (c) => ownText(c, text));
		for (const key of Object.keys(matches)) if (!matches[key]) delete matches[key];
		return matches;
	};

	const describeElement = (el) => {
		const root = rootOf(el);
		const tag = el.tagName.toLowerCase();
		const testId = el.getAttribute("data-testid") || "";
		const id = el.id || "";
		const nameAttr = el.getAttribute("name") || "";
		const attr = TEST_ATTRS.find((name) => el.hasAttribute(name));
		const attrValue = attr ? el.getAttribute(attr) || "" : "";
		const role = roleOf(el);
		const name = nameOf(el);
		const label = labelOf(el);
		const placeholder = line(el.getAttribute("placeholder") || "");
		return {
			tag,
			role,
			name,
			label,
			placeholder,
			matches: countMatches(el, root, role, name, label, placeholder),
			text: ["input", "textarea", "select"].includes(tag) || el.isContentEditable ? "" : textOf(el),
			testId: line(testId),
			testIdUnique: Boolean(testId) && count(root, `[data-testid="${CSS.escape(testId)}"]`) === 1,
			testAttr: attr
				? {
						name: attr,
						value: line(attrValue),
						unique: count(root, `[${attr}="${CSS.escape(attrValue)}"]`) === 1,
					}
				: null,
			id: line(id),
			idUnique: Boolean(id) && count(root, `#${CSS.escape(id)}`) === 1,
			nameAttr: line(nameAttr),
			nameUnique: Boolean(nameAttr) && count(root, `${tag}[name="${CSS.escape(nameAttr)}"]`) === 1,
			type: line(el.getAttribute("type") || ""),
			autocomplete: line(el.getAttribute("autocomplete") || ""),
			path: cssPath(el),
			secret: isSecret(el),
		};
	};

	// The element, the shadow hosts above it (outermost first), and whether it is new.
	const describe = (el) => {
		const hosts = [];
		for (let host = hostOf(el); host && hosts.length < MAX_DEPTH; host = hostOf(host)) {
			hosts.unshift(describeElement(host));
		}
		return { ...describeElement(el), shadow: hosts, appeared: appeared(el) };
	};
	// For Python: the <iframe> element of a child frame, described in this frame.
	window.__workpilotDescribe = (el) => (el && el.nodeType === 1 ? describe(el) : null);

	// The element the event happened on, inside open shadow roots too.
	const origin = (event) => {
		const path = typeof event.composedPath === "function" ? event.composedPath() : [];
		return path.length ? path[0] : event.target;
	};

	// What a loading indicator has, for Python to build its selector from.
	const loaderOf = (el) => ({
		testId: line(el.getAttribute("data-testid") || ""),
		id: line(el.id || ""),
		role: roleOf(el),
		busy: el.getAttribute("aria-busy") === "true",
		className: line(typeof el.className === "string" ? el.className : ""),
	});

	// After action `at`: propose what showed up, report a loader that went away.
	const watch = (at) => {
		changed = new Set();
		loaders = new Set();
		setTimeout(() => {
			if (actions !== at) return;
			suggest(Array.from(changed));
		}, SUGGEST_AFTER_MS);
		const seen = new Map();
		const started = Date.now();
		const timer = setInterval(() => {
			if (actions !== at || Date.now() - started > SETTLE_FOR_MS) {
				clearInterval(timer);
				return;
			}
			for (const loader of loaders) {
				if (hostOf(loader)) continue;
				if (shows(loader) && loader.matches(LOADER)) seen.set(loader, loaderOf(loader));
				else if (seen.has(loader)) {
					clearInterval(timer);
					send({ kind: "settled", loader: seen.get(loader) });
					return;
				}
			}
		}, SETTLE_POLL_MS);
	};

	const suggest = (candidates) => {
		const texts = new Set();
		for (const el of candidates) {
			if (texts.size >= 3) return;
			const text = shows(el) ? textOf(el) : "";
			if (!text || texts.has(text)) continue;
			texts.add(text);
			send({ kind: "suggest", target: describe(el), text });
		}
	};

	// A page an action led to: its main heading and alerts may be checked.
	const onLoad = () =>
		setTimeout(() => suggest(Array.from(document.querySelectorAll('h1, [role="alert"]'))), SUGGEST_AFTER_MS);
	if (document.readyState === "complete") onLoad();
	else window.addEventListener("load", onLoad, { once: true });

	const act = (report) => {
		send(report);
		actions += 1;
		watch(actions);
	};

	const ACTIONABLE =
		'button, a[href], input, select, textarea, summary, label, [role], [data-testid], [data-test], [data-cy], [data-qa], [onclick], [tabindex], [draggable="true"]';

	const actionable = (node) => {
		const el = node && node.nodeType === 1 ? node : node && node.parentElement;
		if (!el) return null;
		return el.closest(ACTIONABLE) || el;
	};

	// The editing host of a contenteditable element, or null.
	const editable = (el) => {
		if (!el || el.nodeType !== 1 || !el.isContentEditable) return null;
		let host = el;
		while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
		return host;
	};

	const isTextField = (el) => {
		if (editable(el)) return true;
		const tag = el.tagName.toLowerCase();
		if (tag === "textarea") return true;
		return tag === "input" && TEXT_INPUTS.test((el.getAttribute("type") || "").toLowerCase());
	};

	// A pointer drag ends on another element: its click is not an action.
	let skipClickUntil = 0;
	document.addEventListener(
		"click",
		(event) => {
			if (Date.now() < skipClickUntil) return;
			const el = actionable(origin(event));
			if (!el) return;
			if (event.altKey) {
				// Alt+click: assert the element's visible text instead of clicking it.
				event.preventDefault();
				event.stopImmediatePropagation();
				send({ kind: "assert_text", target: describe(el), text: textOf(el) });
				return;
			}
			const tag = el.tagName.toLowerCase();
			// The click on a label reaches its field next; a field's focus is its fill.
			if ((tag === "label" && el.control) || tag === "select" || tag === "option") return;
			if (isTextField(el)) return;
			act({ kind: "click", target: describe(el) });
		},
		true,
	);

	document.addEventListener(
		"input",
		(event) => {
			const field = origin(event);
			if (!field || field.nodeType !== 1 || !isTextField(field)) return;
			const host = editable(field);
			const el = host || field;
			const target = describe(el);
			const value = host ? el.innerText || "" : el.value || "";
			act({ kind: "fill", target, value: target.secret ? "" : String(value) });
		},
		true,
	);

	const onChange = (event) => {
		const el = origin(event);
		if (!el || el.nodeType !== 1 || el.tagName.toLowerCase() !== "select") return;
		const values = el.multiple ? Array.from(el.selectedOptions, (o) => String(o.value)).slice(0, 21) : [];
		act({ kind: "select", target: describe(el), value: String(el.value || ""), values });
	};
	document.addEventListener("change", onChange, true);
	// `change` does not leave a shadow root: listen in each open one the page attaches.
	const attachShadow = Element.prototype.attachShadow;
	if (typeof attachShadow === "function") {
		Element.prototype.attachShadow = function (init) {
			const root = attachShadow.call(this, init);
			if (init && init.mode === "open") listenIn(root);
			return root;
		};
	}
	// A shadow root the parser attached (declarative): found on the way out of an event.
	const listened = new WeakSet();
	function listenIn(root) {
		if (listened.has(root)) return;
		listened.add(root);
		root.addEventListener("change", onChange, true);
		observer.observe(root, OBSERVED);
	}
	const findRoots = (event) => {
		const path = typeof event.composedPath === "function" ? event.composedPath() : [];
		for (const node of path) if (node instanceof ShadowRoot && node.mode === "open") listenIn(node);
	};
	for (const name of ["focusin", "pointerdown", "mouseover"]) document.addEventListener(name, findRoots, true);

	// Hover: the pointer rests on an element that shows something while hovered:
	// a CSS rule `X:hover Y` whose X is the element or holds it, or the page
	// inserting an element, or changing one near it, meanwhile.
	const MAX_RULES = 3000;
	let hoverRules = null;
	const collectRules = (rules, out) => {
		for (const rule of rules) {
			if (out.length >= MAX_RULES) return;
			if (rule.cssRules) collectRules(rule.cssRules, out);
			const text = typeof rule.selectorText === "string" ? rule.selectorText : "";
			for (const part of text.includes(":hover") ? text.split(",") : []) {
				const at = part.indexOf(":hover");
				const trigger = part.slice(0, at).trim();
				const shown = part.slice(at + ":hover".length).trim();
				// `X:hover Y` or `X:hover > Y`: hovering X shows Y, which is not X.
				if (trigger && shown && !shown.startsWith(":")) out.push(trigger);
			}
		}
	};
	const triggers = () => {
		if (hoverRules) return hoverRules;
		const out = [];
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				collectRules(sheet.cssRules, out);
			} catch (_error) {
				// A sheet of another origin cannot be read.
			}
		}
		hoverRules = out;
		return out;
	};
	const revealsByCss = (el) =>
		triggers().some((trigger) => {
			try {
				return Boolean(el.closest(trigger));
			} catch (_error) {
				return false;
			}
		});
	let hovered = null;
	let lastHover = null;
	let hoverWatch = null;
	const noteHoverChange = (record) => {
		if (!hoverWatch || hoverWatch.changed) return;
		if (record.type === "attributes" && hoverWatch.scope.contains(record.target)) hoverWatch.changed = true;
		for (const node of record.addedNodes || []) if (node.nodeType === 1) hoverWatch.changed = true;
	};
	document.addEventListener(
		"mouseover",
		(event) => {
			const el = actionable(origin(event));
			if (!el || el === hovered) return;
			hovered = el;
			const watch = { scope: el.parentElement || el, changed: false };
			hoverWatch = watch;
			const at = actions;
			setTimeout(() => {
				if (hoverWatch === watch) hoverWatch = null;
				if (hovered !== el || actions !== at || lastHover === el) return;
				if (!watch.changed && !revealsByCss(el)) return;
				lastHover = el;
				act({ kind: "hover", target: describe(el) });
			}, HOVER_MS);
		},
		true,
	);
	document.addEventListener(
		"mouseout",
		(event) => {
			if (actionable(origin(event)) === hovered) hovered = null;
		},
		true,
	);

	// Scroll: only one the person made (wheel, touch, keys, scrollbar), once it rests.
	let intentAt = 0;
	const intent = () => {
		intentAt = Date.now();
	};
	for (const name of ["wheel", "touchmove"]) document.addEventListener(name, intent, true);
	// A press on a scrollbar (past the content box of what was pressed).
	document.addEventListener(
		"mousedown",
		(event) => {
			const el = event.target;
			if (!el || el.nodeType !== 1) return;
			if (el === document.documentElement || event.offsetX > el.clientWidth || event.offsetY > el.clientHeight) intent();
		},
		true,
	);
	document.addEventListener("keydown", (event) => SCROLL_KEYS.test(event.key) && intent(), true);
	const resting = new Map();
	document.addEventListener(
		"scroll",
		(event) => {
			if (Date.now() - intentAt > 1000) return;
			const node = origin(event);
			const el = node === document || node === document.documentElement || !node || node.nodeType !== 1 ? null : node;
			clearTimeout(resting.get(el));
			resting.set(
				el,
				setTimeout(() => {
					resting.delete(el);
					const x = Math.round(el ? el.scrollLeft : window.scrollX);
					const y = Math.round(el ? el.scrollTop : window.scrollY);
					act({ kind: "scroll", target: el ? describe(el) : null, x: Math.max(0, x), y: Math.max(0, y) });
				}, SCROLL_REST_MS),
			);
		},
		true,
	);

	// Drag and drop: drag events, or a pointer pressed on one element and released on another.
	let dragged = null;
	let pressed = null;
	document.addEventListener(
		"dragstart",
		(event) => {
			dragged = actionable(origin(event));
			pressed = null;
		},
		true,
	);
	document.addEventListener(
		"drop",
		(event) => {
			const source = dragged;
			dragged = null;
			const target = actionable(origin(event));
			if (!source || !target || source === target || source.contains(target)) return;
			act({ kind: "drag", target: describe(source), drop: describe(target), mode: "html5" });
		},
		true,
	);
	document.addEventListener(
		"pointerdown",
		(event) => {
			pressed = event.button === 0 ? { el: actionable(origin(event)), x: event.clientX, y: event.clientY } : null;
		},
		true,
	);
	document.addEventListener(
		"pointerup",
		(event) => {
			const start = pressed;
			pressed = null;
			if (!start || !start.el || dragged) return;
			if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_MIN_PX) return;
			const selection = window.getSelection ? String(window.getSelection() || "") : "";
			// Under the pointer, past the dragged element (a library may move it along).
			const under = (document.elementsFromPoint ? document.elementsFromPoint(event.clientX, event.clientY) : []).find(
				(node) => !start.el.contains(node),
			);
			const target = actionable(under);
			const field = /^(input|select|textarea)$/i.test(start.el.tagName) || isTextField(start.el);
			if (selection || field || !target || target === start.el || target.contains(start.el)) return;
			skipClickUntil = Date.now() + 300;
			act({ kind: "drag", target: describe(start.el), drop: describe(target), mode: "pointer" });
		},
		true,
	);

	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Enter" && event.key !== "Escape") return;
			const target = origin(event);
			const el = target && target.nodeType === 1 ? target : document.body;
			if (event.key === "Enter" && el.tagName.toLowerCase() === "textarea") return;
			act({ kind: "press", target: describe(el), key: event.key });
		},
		true,
	);
})();
