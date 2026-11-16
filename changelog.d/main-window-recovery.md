---
section: 🐛 Corrections
---

- **A white window reloads itself.** When the window's renderer died (crash, out of memory, GPU
  reset) or its page failed to load, the window stayed white until the app was restarted. It now
  reloads, at most three times a minute, and the log says what took it down (renderer, page load
  or GPU process), so a white window that comes back can be explained.
