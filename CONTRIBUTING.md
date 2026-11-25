# Contributing

`rustel-vscode` is a zero-dependency VS Code extension for [Rustel](https://github.com/tzfm/rustel). Keep it small, fast, and free of third-party runtime dependencies or build steps.

## Before opening a pull request

Run:

```sh
node --check src/protocol.js
node --check src/lsp-client.js
node --check src/player.js
node --check src/extension.js
node --test
```

To also verify a live roundtrip against a local `rustel` binary:

```sh
RUSTEL_BIN=rustel node --test
```

## Where code lives

The extension splits protocol handling, process lifecycles, and VS Code wiring into four files so protocol and lifecycle logic stay testable without launching VS Code:

```text
VS Code UI (src/extension.js)
  |-- src/lsp-client.js  -- stdio LSP --> rustel lsp --stdio
  |     `-- src/protocol.js (Content-Length framing, bounds)
  `-- src/player.js      -- NDJSON -----> rustel play --watch --ui-events
        `-- src/protocol.js (NDJSON lines, UTF-8 to UTF-16 map, SHA-256)
```

- `src/protocol.js`: bounded LSP `Content-Length` framing, NDJSON line parsing, SHA-256 revision hashing, and UTF-8 byte to UTF-16 offset mapping.
- `src/lsp-client.js`: explicit `stopped`, `starting`, `running`, `stopping` state machine for `rustel lsp --stdio`.
- `src/player.js`: explicit `stopped`, `playing`, `stopping` state machine for `rustel play --watch --ui-events` and clean `transport` stop control.
- `src/extension.js`: VS Code providers (completion, hover, signature help, diagnostics), commands, status bar, and bounded real-time token highlighting.
- `syntaxes/strudel.tmLanguage.json`: Strudel lane labels and mini-notation strings layered over VS Code's built-in `source.js` grammar.

## Rules

- Keep runtime and dev dependencies empty in `package.json`. Use VS Code APIs and Node built-ins only.
- Bound every buffer, header, frame, pending request map, and highlight list.
- Keep `src/protocol.js`, `src/lsp-client.js`, and `src/player.js` free of `vscode` imports so `node --test` covers them directly.
- Set `MarkdownString.isTrusted = false` on every hover, completion, and signature documentation string.
- Never parse `$:` score snippets as VS Code `SnippetString` tabstops. Only apply `SnippetString` when `insertTextFormat === 2`.
- Keep comments short and in the present tense.

## Tests

Tests live under `test/` and use Node's built-in `node:test` and `node:assert/strict` modules:

- `test/protocol.test.js`: framing edge cases, split multi-byte UTF-8 chunks, oversized frame rejection, NDJSON lines, and byte-to-UTF-16 mapping.
- `test/lsp-client.test.js`: full LSP lifecycle against an in-memory stdio server, missing-binary handling, and an optional live `RUSTEL_BIN` check.
- `test/player.test.js`: `--watch --ui-events` streaming, reload behavior, `transport: stop` control, and temp file cleanup.

## CI and releases

`.github/workflows/ci.yml` runs syntax checks, manifest validation, and `node --test` on Linux, macOS, and Windows with read-only repository tokens and `persist-credentials: false`.

`.github/workflows/release.yml` runs on `v*` tags (and manual dry-run dispatches). On a tag push it checks that the tag matches `package.json` and sits on `main`, runs the full test suite, packages a `.vsix` with `@vscode/vsce`, creates the GitHub Release, and publishes to the VS Code Marketplace using Trusted Publishing (OIDC) without long-lived secrets.

## Public evidence privacy

Do not commit workstation details, usernames, local paths, hostnames, or personal metadata in code, commits, tests, or pull request text.

## Licence

Contributions are AGPL-3.0-or-later, matching Rustel. See [LICENSE](LICENSE).
