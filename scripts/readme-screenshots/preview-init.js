// Runs in the page before the renderer's browser preview starts.
//
// The preview stands `browser-mock.ts` in for `window.electronAPI`. That mock
// is partial, so a view calling a method it lacks would crash the page. This
// wraps whatever object the app installs: a method named in
// `window.__DEMO_OVERRIDES__` (filled by demo-data.js) answers first, a method
// in `__DEMO_OVERRIDES__.__wrap` post-processes the mock's own answer, and a
// missing method answers "nothing" instead of throwing.
(() => {
	window.__DEMO_OVERRIDES__ = window.__DEMO_OVERRIDES__ || {};
	const overrides = window.__DEMO_OVERRIDES__;
	const unsubscribe = () => {};
	const wrap = (target) =>
		new Proxy(target, {
			get(t, prop) {
				if (typeof prop !== "string") return t[prop];
				if (prop in overrides) return overrides[prop];
				const post = overrides.__wrap?.[prop];
				if (post && typeof t[prop] === "function") {
					return async (...args) => post(await t[prop](...args), ...args);
				}
				if (prop in t) return t[prop];
				if (/^on[A-Z]/.test(prop)) return () => unsubscribe;
				return async () => ({ success: true, data: null });
			},
		});
	let api;
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		get() {
			return api;
		},
		set(value) {
			api = value ? wrap(value) : value;
		},
	});
})();
