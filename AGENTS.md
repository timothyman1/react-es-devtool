## What this is

A TanStack Devtools plugin (published as `event-source-devtool`) that records Server-Sent Events streams, both from `EventSource` and from `fetch` responses with `text/event-stream`, and shows them in a panel. The only public export is `EventSourcePanel` from `src/event-source.tsx`.

## Commands

Package manager is pnpm.

- `pnpm build` runs `vite build` (library mode, entry `src/event-source.tsx` → `dist/index.js`) and then `tsc -p tsconfig.lib.json`, which emits only `.d.ts` files.
- `pnpm typecheck` runs `tsc --noEmit` over `src` and `vite.config.ts`.
- `pnpm lint` runs oxlint.
- Release: `npm version patch|minor|major`, `git push --follow-tags`, then `gh release create vX.Y.Z --generate-notes`. Publishing the release runs `.github/workflows/publish.yml`, which publishes to npm via trusted publishing (OIDC, no token). The workflow fails if the tag doesn't match `package.json`.

There is no test runner and no demo page. To try a change, link the package into a host app and run `pnpm exec vite build --watch`.

## Architecture

There are two modules, and data flows one way through the TanStack devtools event bus:

1. **`src/tapped-es.ts`: capture.** `installTap()` monkey-patches `window.EventSource` (as a subclass) and `window.fetch`. Each stream gets a `track()` handle that emits `open` / `message` / `close` on `eventClient` (an `EventClient<SseEvents>` with `pluginId: 'event-source'`).
   - A fetch counts as SSE if the request sends `Accept: text/event-stream` _or_ the response has an SSE content type. The request check means failed requests with HTML or JSON error bodies still get recorded.
   - Fetch bodies are wrapped in a pull-through `ReadableStream`, not `tee()`, so a cancel from the app still cancels the network read. `parseSse()` is an incremental SSE parser that handles CRLF split across chunks.
   - Once a stream is `closed`, it emits nothing more. URLs are redacted for `session|token|key|auth` query params, and message data is capped at 4 KB.
   - An `INSTALLED` global symbol keeps HMR from wrapping the globals twice. `TAB_ID` is kept on a global too, because the tap from the first run keeps emitting with it.
2. **`src/event-source.tsx`: store and UI.** A module-level `Map` of streams plus `useSyncExternalStore`, with notifications batched to one per `requestAnimationFrame`.
   - **Subscriptions happen at module load, not in the panel.** The bus doesn't replay events, and the panel only mounts while its devtools tab is open. `installTap()` is called _after_ subscribing, so the first stream isn't missed.
   - All of this is guarded by `typeof window !== 'undefined' && process.env.NODE_ENV === 'development'`. The module is imported statically, so it must do nothing on the server (the file is `'use client'`, for Next) and in production builds.
   - **Production is a no-op.** `EventSourcePanel` is `process.env.NODE_ENV === 'development' ? Panel : () => null`, the same pattern as TanStack's `EventClient`. The consumer's bundler folds the ternary and tree-shakes the panel, its CSS and the store (a consumer production bundle is about 200 bytes). The library build can't do this in `vite.config.ts`, because one `dist` serves both modes and Vite's library mode leaves `process.env` alone on purpose. Keep top-level statements droppable: wrap a side effect (a global write, a `sessionStorage` read, a loop) in a function and call it with `/* @__PURE__ */`.
   - **HMR:** the streams and row counter live on a `Symbol.for('event-source-devtool')` global. A re-run of the module (Vite HMR, or a Next rebuild of the linked `dist`) keeps them and replaces the previous bus subscriptions.
   - **Multi-tab:** the bus rebroadcasts events to other tabs. Stream ids are prefixed with the tab's `TAB_ID`, and `record()` drops ids that don't match.
   - History is saved to `sessionStorage` on `pagehide`, with open streams marked closed with reason `page-unload`. Caps: 200 streams and 500 rows per stream.
   - There are two views: `RowView` (normal; click a row to pretty-print its JSON) and `TableView`, the default. `TableView` flattens JSON message data into dot-path columns and right-aligns columns that are all numbers.

## Styling

`src/index.css` is imported with `?inline` and rendered as a React 19 `<style href precedence>`, so the styles ship with the component. Keep in mind:

- Tailwind v4 without preflight: the panel renders inside the host page, so a global reset would restyle the host app. There's a scoped reset under `.es-root` instead.
- **Every utility is prefixed `es:`** (`prefix(es)` on the theme import): write `es:flex`, `es:hover:bg-hover`, never a bare `flex`. Theme variables come out as `--es-*`. This way the panel shares no class names or variables with the host app, in either direction.
- The reset and utilities are **unlayered** on purpose. Unlayered host CSS (e.g. Tailwind v3's preflight `button { background-color: transparent }`) beats any `@layer` rule, however specific. That's only safe because of the prefix: an unprefixed, unlayered `.flex` overrode the host's own responsive rules. `@tailwind utilities` stays at the end of the file so utilities win over the reset, which has the same specificity.
- The `<style>` href is a hash of the CSS, because React never updates a hoisted style in place. In development, the panel removes `event-source-devtool-*` styles left over from earlier hot reloads.
- Colors are tokens (`es:bg-bg`, `es:text-muted`, `es:border-border`, …) declared in `@theme` as literal HSL values, so Tailwind emits them on `:root` as `--es-color-*` and generates the utilities. Light mode overrides the `--es-color-*` variables on `.es-root[data-es-theme="light"]`, driven by the devtools `theme` prop. Keep them in `@theme`: Tailwind generates no utilities for tokens that are only defined in a plain `:root` rule.

## Conventions

- `react` and `@tanstack/devtools-event-client` are externals in the library build. React ≥19 is a peer dependency.
- `// ponytail:` comments mark deliberate shortcuts that have a known limit (retry timing, storage caps). Keep them up to date when you change the related code.
