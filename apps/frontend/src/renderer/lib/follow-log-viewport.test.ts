import { afterEach, expect, it, vi } from "vitest";
import { followLogViewport } from "./follow-log-viewport";
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])("pauses reading and resumes at bottom (scroll event delivered: %s)", (delivered) => {
 let resize = () => { /* assigned by the observer constructor */ };
 vi.stubGlobal("ResizeObserver", class {
  constructor(cb: () => void) { resize = cb; }
  observe() { /* simulated layout */ }
  disconnect() { /* simulated layout */ }
 });
 const el = document.createElement("div");
 let height = 1000;
 Object.defineProperty(el, "scrollHeight", { get: () => height });
 Object.defineProperty(el, "clientHeight", { value: 200 });
 el.scrollTo = vi.fn((options: ScrollToOptions) => { el.scrollTop = Math.min(options.top ?? 0, height - 200); }) as typeof el.scrollTo;
 const stop = followLogViewport(el);
 expect(el.scrollTop).toBe(800);
 el.scrollTop = 400;
 el.dispatchEvent(new Event("scroll"));
 height = 1200;
 resize();
 expect(el.scrollTop).toBe(400);
 el.scrollTop = 1000;
 if (delivered) el.dispatchEvent(new Event("scroll"));
 height = 1400;
 resize();
 expect(el.scrollTop).toBe(1200);
 stop();
});

