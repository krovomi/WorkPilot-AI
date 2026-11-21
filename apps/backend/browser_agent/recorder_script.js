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
// Everything sent is plain data that Python bounds and checks again.
(() => {
	if (window.__workpilotRecorder) return;
	window.__workpilotRecorder = true;

	const MAX = 200;
	const SECRET = /pass|pwd|secret|token|api[-_ ]?key|otp|cvc|cvv|\bpin\b/i;
	const SECRET_AUTOCOMPLETE = /password|one-time-code|cc-number|cc-csc/i;
	const TEST_ATTRS = ["data-test", "data-cy", "data-qa"];
	const TEXT_INPUTS = /^(|text|email|password|search|tel|url|number|date|time|datetime-local|month|week)$/;

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

	// Elements the page inserted, by the number of actions sent before.
	let actions = 0;
	const inserted = new WeakMap();
	new MutationObserver((records) => {
		if (!actions) return;
		for (const record of records) {
			for (const node of record.addedNodes) if (node.nodeType === 1) inserted.set(node, actions);
		}
	}).observe(document, { childList: true, subtree: true });

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

	const describeElement = (el) => {
		const root = rootOf(el);
		const tag = el.tagName.toLowerCase();
		const testId = el.getAttribute("data-testid") || "";
		const id = el.id || "";
		const nameAttr = el.getAttribute("name") || "";
		const attr = TEST_ATTRS.find((name) => el.hasAttribute(name));
		const attrValue = attr ? el.getAttribute(attr) || "" : "";
		return {
			tag,
			role: line(el.getAttribute("role") || "").split(" ")[0] || implicitRole(el),
			name: nameOf(el),
			label: labelOf(el),
			placeholder: line(el.getAttribute("placeholder") || ""),
			text: ["input", "textarea", "select"].includes(tag) ? "" : textOf(el),
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
		for (let host = hostOf(el); host && hosts.length < 5; host = hostOf(host)) {
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

	const act = (report) => {
		send(report);
		actions += 1;
	};

	const ACTIONABLE =
		'button, a[href], input, select, textarea, summary, label, [role], [data-testid], [data-test], [data-cy], [data-qa], [onclick], [tabindex]';

	const actionable = (node) => {
		const el = node && node.nodeType === 1 ? node : node && node.parentElement;
		if (!el) return null;
		return el.closest(ACTIONABLE) || el;
	};

	const isTextField = (el) => {
		const tag = el.tagName.toLowerCase();
		if (tag === "textarea") return true;
		return tag === "input" && TEXT_INPUTS.test((el.getAttribute("type") || "").toLowerCase());
	};

	document.addEventListener(
		"click",
		(event) => {
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
			const el = origin(event);
			if (!el || el.nodeType !== 1 || !isTextField(el)) return;
			const target = describe(el);
			act({ kind: "fill", target, value: target.secret ? "" : String(el.value || "") });
		},
		true,
	);

	const onChange = (event) => {
		const el = origin(event);
		if (!el || el.nodeType !== 1 || el.tagName.toLowerCase() !== "select") return;
		act({ kind: "select", target: describe(el), value: String(el.value || "") });
	};
	document.addEventListener("change", onChange, true);
	// `change` does not leave a shadow root: listen in each open one the page attaches.
	const attachShadow = Element.prototype.attachShadow;
	if (typeof attachShadow === "function") {
		Element.prototype.attachShadow = function (init) {
			const root = attachShadow.call(this, init);
			if (init && init.mode === "open") root.addEventListener("change", onChange, true);
			return root;
		};
	}

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
