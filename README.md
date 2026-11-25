# Rustel for VS Code

VS Code extension for [Rustel](https://github.com/tzfm/rustel)

Uses `rustel lsp --stdio` for completion, hover docs, and lint diagnostics, and `rustel play --watch --ui-events` for live playback with real-time note highlighting.

## Install

Requires a `rustel` binary with `rustel lsp --stdio` on your `PATH` (or set `rustel.serverPath`).

macOS and Linux:

```sh
git clone https://github.com/undy-aeon/rustel-vscode.git ~/.vscode/extensions/rustel-vscode
```

Windows (PowerShell):

```powershell
git clone https://github.com/undy-aeon/rustel-vscode.git "$env:USERPROFILE\.vscode\extensions\rustel-vscode"
```

Reload VS Code. Run `git pull` in that folder to update.

## Use

Open `examples/demo.strudel` (or any `.strudel` / `.std` file):

- Hover a function to read its docs.
- Type `.` or trigger completion inside `s("...")`, `scale("...")`, or `chord("...")`.
- `Ctrl+Enter` (`Cmd+Enter` on macOS): play or update the score.
- `Ctrl+Shift+Enter` (`Cmd+Shift+Enter`): play the selection or current line.
- `Ctrl+.` (`Cmd+.`): stop playback.

## Settings

- `rustel.serverPath`: path to `rustel` (default `rustel`).
- `rustel.extraPlayArgs`: extra flags for `rustel play` (for example `["--output", "silent"]`).
- `rustel.highlightEvents`: highlight active tokens during playback (default `true`).
- `rustel.trace`: set to `messages` to inspect raw LSP frames in the Rustel output log.

## Test and publish

- Open this folder in VS Code and press `F5` to launch a test window.
- Run `node --test` (or `RUSTEL_BIN=rustel node --test` for a live LSP check).
- Package or publish to the VS Code Marketplace with `npx @vscode/vsce package` or `npx @vscode/vsce publish`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
