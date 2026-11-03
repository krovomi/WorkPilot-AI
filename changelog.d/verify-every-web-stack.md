---
section: 🐛 Corrections
---

- **La vérification ouvre dans Chrome toutes les apps web, quelle que soit la stack.** La phase
  *Vérification* d'une tâche pilote Chrome DevTools MCP (Playwright en secours) pour lire la
  console et le réseau, faire les captures desktop et mobile et tracer la performance. Les pages
  rendues par un backend (Blazor Server / Blazor Web App, Razor Pages, MVC, Django, Flask,
  Express avec vues, Thymeleaf, templates Go, Rails, Laravel…) étaient prises pour une simple API
  et jamais ouvertes : elles le sont maintenant, en plus des appels d'endpoints. PHP (Laravel,
  Symfony, PHP simple), Ruby (Rails, Rack), Rust (Leptos, Yew/Trunk, Dioxus, Axum, Actix,
  Rocket…), les sites statiques et React sur webpack, Remix, Gatsby, Solid, Qwik, Lit, Ember,
  Docusaurus ou Eleventy sont détectés et lancés.
