# Rustel for VS Code

A minimal, zero-dependency VS Code extension for [Rustel](https://github.com/tzfm/rustel).

It connects VS Code directly to `rustel lsp --stdio` for editor intelligence and to `rustel play --watch --ui-events` for live playback with real-time note highlighting.

## Features

- Live lint diagnostics (syntax errors, value warnings, and notes) from `rustel lsp --stdio`
- Contextual autocomplete for top-level functions, `.` method chains, and sound, scale, and chord names inside strings
- Hover documentation matching `rustel doc`
- Live playback directly in VS Code with `Ctrl+Enter` (`Cmd+Enter` on macOS) and stop with `Ctrl+.` (`Cmd+.` on macOS)
- Real-time token highlighting while a score plays
- Syntax highlighting for `.strudel` and `.std` files
- No npm packages and no build step required

## Requirements

Install a `rustel` binary that includes `rustel lsp --stdio` and `--ui-events` support. Put `rustel` on your `PATH`, or point the `rustel.serverPath` setting to the binary.

Verify your binary first:

```sh
rustel lsp --help
```

## Install

Because this extension has zero third-party dependencies, you can install it directly without `npm install`.

### Option 1: Install straight into VS Code (fastest)

macOS and Linux:

```sh
git clone https://github.com/undy-aeon/rustel-vscode.git ~/.vscode/extensions/rustel-vscode
```

Windows (PowerShell):

```powershell
git clone https://github.com/undy-aeon/rustel-vscode.git "$env:USERPROFILE\.vscode\extensions\rustel-vscode"
```

Reload VS Code (`Ctrl+Shift+P` or `Cmd+Shift+P`, then run `Developer: Reload Window`).

To update later, run `git pull` inside that folder and reload VS Code.

### Option 2: Run in a test window (`F5`)

Clone the repository anywhere, open the folder in VS Code, and press `F5`. VS Code opens an Extension Development Host window with `examples/demo.strudel` ready to test.

### Option 3: Package a `.vsix` file (optional)

If you have Node.js installed and want a portable `.vsix` bundle:

```sh
npx @vscode/vsce package
code --install-extension rustel-vscode-0.1.0.vsix
```

## Test the LSP and playback

Open `examples/demo.strudel` and check each feature:

1. Hover over `note`, `s`, `lpf`, or `room` to see signatures, parameters, and examples from `rustel lsp --stdio`.
2. Place the cursor after `.gain(0.25)` and type `.` to test method completion.
3. Place the cursor inside `s("triangle")` and trigger completion (`Ctrl+Space`) to browse built-in sounds.
4. Uncomment the last line (`note("c4").lpf(`) to verify live diagnostic squiggles.
5. Press `Ctrl+Enter` (`Cmd+Enter` on macOS) to start audio playback and watch active notes highlight in the editor. Edit the score and press `Ctrl+Enter` again to hot-reload.
6. Press `Ctrl+.` (`Cmd+.` on macOS) to stop playback.

To inspect every raw JSON-RPC message exchanged with `rustel lsp --stdio`, set `rustel.trace` to `messages` and run `Rustel: Show Output Log` from the Command Palette.

## Shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Play or update score | `Ctrl+Enter` | `Cmd+Enter` |
| Play selection or current line | `Ctrl+Shift+Enter` | `Cmd+Shift+Enter` |
| Stop playback | `Ctrl+.` | `Cmd+.` |

Editor title buttons also provide Play and Stop controls on `.strudel` files.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `rustel.serverPath` | `rustel` | Path to the `rustel` executable |
| `rustel.extraPlayArgs` | `[]` | Extra flags passed to `rustel play` (for example `["--output", "silent"]`) |
| `rustel.highlightEvents` | `true` | Highlight sounding mini-notation tokens during playback |
| `rustel.trace` | `off` | Set to `messages` to log raw LSP and UI protocol frames |

## Automated tests

Run the zero-dependency Node test suite:

```sh
node --test
```

To also run the live roundtrip test against a local `rustel` binary:

```sh
RUSTEL_BIN=rustel node --test
```

## Publishing to the VS Code Marketplace

This repository already includes the manifest fields, `128x128` PNG icon, license, changelog, and `.vscodeignore` required for publishing:

1. Create a publisher on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) and match the `publisher` field in `package.json`.
2. Log in with your Personal Access Token:

```sh
npx @vscode/vsce login undy-aeon
```

3. Package and publish:

```sh
npx @vscode/vsce publish
```

For Open VSX (VSCodium, Cursor, Windsurf), publish the same `.vsix` with `npx ovsx publish`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
