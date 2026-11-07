# Pointing an element of the task preview

> Rationale for `main/preview-point.ts`, `main/ipc-handlers/task/preview-point-handlers.ts` and
> `shared/utils/element-sources.ts`. The normative summary is the row in
> [`docs/CLAUDE.md`](../CLAUDE.md); where the two disagree, `docs/CLAUDE.md` wins.

## Why

Most remarks on an interface read "this button, here, should…". Writing it in words, or pasting a
screenshot, leaves the agent to find which element and which file. Pointing the element gives it
the exact DOM, the computed style and the probable source file.

## How the element is picked: the DevTools protocol, never a script

The preview is a `<webview>` without preload, sandboxed, without Node
(`main/security/webview-policy.ts`). That stays as it is: nothing is injected into the page.

The main process attaches the guest's debugger (`webContents.debugger`, CDP 1.3) and sends:

1. `DOM.enable`, `CSS.enable`, `Overlay.enable`, then `Overlay.setInspectMode` in
   `searchForNode` mode: the DevTools element picker, drawn by Chromium.
2. On `Overlay.inspectNodeRequested`, the node's backend id is pushed to the frontend
   (`DOM.pushNodesByBackendIdsToFrontend`); its ancestors arrive as `DOM.setChildNodes`, which
   gives the DOM path without a `DOM.getDocument` of the whole page.
3. `DOM.describeNode` (attributes, inline `on*` handlers dropped), `DOM.getOuterHTML` (cut),
   `CSS.getComputedStyleForNode` (a few properties), `DOM.getBoxModel` then `capturePage` on the
   box for the image.
4. The overlay is turned off and the debugger detached in a `finally`.

No `Runtime` command is ever sent. A preview whose DevTools are open already holds the debugger:
the pick is refused (`devtools_open`) rather than taking it over.

The renderer passes the `<webview>`'s id; the main only accepts a guest of type `webview` whose
host is the window that asks (rule S6). The task id is checked against local tasks; a server card
or a finished task is refused.

## From the node to the file, whatever the stack

`element-sources.ts` is pure. It takes the node's markers, strongest first: a test id
(`data-testid`, `data-test`, `data-cy`, `data-qa`), an id that does not look generated, the
accessible label, the visible text, the placeholder, the name, then rare classes (utility classes,
CSS-module hashes and generated prefixes are never markers). Each marker is looked for in the
worktree's template files (`git ls-files`, capped in count and size, resolved inside the root):
attribute values between quotes, text with any whitespace, classes as whole words. A marker found
in many files locates nothing and is dropped; a rarer one weighs more. The top five files come
with the line of their strongest marker.

This works on JSX/TSX, Angular templates and inline components, Vue and Svelte files, Blazor
`.razor`, Razor Pages `.cshtml`, Twig, Blade, ERB, Jinja, Go templates, HEEx, Leptos/Yew `.rs`…
because every template language writes an attribute value between quotes and text as text.

## The message

Each pointed element is sent as one steering message (F1, [steering.md](steering.md)):

- `text` is the person's words only;
- `context` holds what the page said (DOM path, probable files, styles, HTML) and the place of
  the image (`pointed/<id>.png` in the spec directory), written by the main process, never taken
  from the renderer.

The prompt quotes `context` with `security.untrusted.quote_untrusted` (fenced as data, cleaned,
recorded): page text is data, never an instruction (rule 4, S2). `steering_section` withholds a
context when no quote is given, so a new caller cannot paste it raw by accident.

## Not covered yet

- A task in human review gets the message at its next session (a requested change). Anchoring it
  as a review comment on the candidate file waits for F9.
- Mobile and desktop apps have no DOM: their preview has no picker.
