import { isLocalHost, normaliseServerUrl, streamBase } from "../api/server-url";

describe("normaliseServerUrl", () => {
	it("adds https to a bare host and drops a trailing slash", () => {
		expect(normaliseServerUrl(" workpilot.example.com/ ")).toEqual({ ok: true, url: "https://workpilot.example.com" });
	});

	it("keeps a port and a base path", () => {
		expect(normaliseServerUrl("https://x.io:8443/wp/")).toEqual({ ok: true, url: "https://x.io:8443/wp" });
	});

	it("refuses plain http to a public host", () => {
		expect(normaliseServerUrl("http://workpilot.example.com")).toEqual({ ok: false, reason: "insecure" });
	});

	it.each(["http://localhost:9000", "http://192.168.1.20:9000", "http://10.0.2.2:9000", "http://box.local"])(
		"accepts plain http on the local network: %s",
		(input) => {
			expect(normaliseServerUrl(input).ok).toBe(true);
		},
	);

	it.each(["", "ftp://x.io", "https://user:pw@x.io", "https://x.io/?a=1", "https://x.io/#frag", "not a url at all"])(
		"refuses %p",
		(input) => {
			expect(normaliseServerUrl(input)).toEqual({ ok: false, reason: expect.any(String) });
		},
	);

	it("does not take a public look-alike for a private range", () => {
		expect(isLocalHost("172.32.0.1")).toBe(false);
		expect(isLocalHost("10.example.com")).toBe(false);
		expect(isLocalHost("172.20.3.4")).toBe(true);
	});
});

describe("streamBase", () => {
	it("prefers the address the server advertises", () => {
		expect(streamBase("https://x.io", "wss://stream.x.io/")).toBe("wss://stream.x.io");
	});

	it("falls back to the API host on the stream port, wss behind https", () => {
		expect(streamBase("https://x.io:8443", null)).toBe("wss://x.io:8765");
		expect(streamBase("http://localhost:9000", "javascript:alert(1)")).toBe("ws://localhost:8765");
	});
});
