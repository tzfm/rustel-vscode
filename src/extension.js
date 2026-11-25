'use strict';

const path = require('path');
const vscode = require('vscode');
const { LspState, RustelLspClient } = require('./lsp-client');
const { PlayState, RustelPlayer } = require('./player');
const { sha256Hex, buildUtf8ToUtf16Mapper } = require('./protocol');

const STRUDEL_SELECTOR = [
  { language: 'strudel', scheme: 'file' },
  { language: 'strudel', scheme: 'untitled' },
];

const MAX_ACTIVE_HIGHLIGHTS = 128;
const HIGHLIGHT_TICK_MS = 33;

let lspClient = null;
let player = null;
let highlighter = null;

function isStrudelDocument(doc) {
  return (
    Boolean(doc) &&
    doc.languageId === 'strudel' &&
    (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled')
  );
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('rustel');
  const serverPath = (cfg.get('serverPath', 'rustel') || 'rustel').trim();
  const trace = cfg.get('trace', 'off') === 'messages' ? 'messages' : 'off';
  const highlightEvents = Boolean(cfg.get('highlightEvents', true));
  const rawExtra = cfg.get('extraPlayArgs', []);
  const extraPlayArgs = Array.isArray(rawExtra)
    ? rawExtra.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  return { serverPath, trace, highlightEvents, extraPlayArgs };
}

function mapLspSeverity(severity) {
  switch (severity) {
    case 1:
      return vscode.DiagnosticSeverity.Error;
    case 2:
      return vscode.DiagnosticSeverity.Warning;
    case 3:
      return vscode.DiagnosticSeverity.Information;
    case 4:
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function mapLspRange(range) {
  if (!range || !range.start || !range.end) {
    return new vscode.Range(0, 0, 0, 0);
  }
  return new vscode.Range(
    Math.max(0, Number(range.start.line) || 0),
    Math.max(0, Number(range.start.character) || 0),
    Math.max(0, Number(range.end.line) || 0),
    Math.max(0, Number(range.end.character) || 0)
  );
}

function mapCompletionKind(lspKind) {
  if (typeof lspKind !== 'number' || lspKind < 1 || lspKind > 25) {
    return vscode.CompletionItemKind.Text;
  }
  // LSP CompletionItemKind is 1-based; VS Code's enum is 0-based.
  return lspKind - 1;
}

function toVsCodeDiagnostics(lspDiagnostics) {
  return lspDiagnostics.map((item) => {
    const diag = new vscode.Diagnostic(
      mapLspRange(item.range),
      typeof item.message === 'string' ? item.message : 'Diagnostic',
      mapLspSeverity(item.severity)
    );
    diag.source = typeof item.source === 'string' ? item.source : 'rustel';
    return diag;
  });
}

function toVsCodeCompletionItem(item) {
  const label = typeof item.label === 'string' ? item.label : '';
  const completion = new vscode.CompletionItem(label, mapCompletionKind(item.kind));
  if (typeof item.detail === 'string' && item.detail.length > 0) {
    completion.detail = item.detail;
  }
  if (typeof item.sortText === 'string' && item.sortText.length > 0) {
    completion.sortText = item.sortText;
  }
  if (typeof item.insertText === 'string' && item.insertText.length > 0) {
    if (item.insertTextFormat === 2) {
      completion.insertText = new vscode.SnippetString(item.insertText);
      if (item.insertText.endsWith('("$0")')) {
        completion.command = {
          command: 'editor.action.triggerSuggest',
          title: 'Suggest arguments',
        };
      } else if (item.insertText.endsWith('($0)')) {
        completion.command = {
          command: 'editor.action.triggerParameterHints',
          title: 'Show parameter hints',
        };
      }
    } else {
      // Plain text keeps `$:` lane prefixes intact without snippet parsing.
      completion.insertText = item.insertText;
    }
  }
  if (item.deprecated) {
    completion.tags = [vscode.CompletionItemTag.Deprecated];
  }
  if (item.documentation) {
    if (typeof item.documentation === 'string') {
      completion.documentation = item.documentation;
    } else if (typeof item.documentation.value === 'string') {
      const md = new vscode.MarkdownString(item.documentation.value);
      md.isTrusted = false;
      completion.documentation = md;
    }
  }
  return completion;
}

/**
 * Schedules bounded real-time token highlights from `rustel play --ui-events`.
 */
class EventHighlighter {
  constructor() {
    this._decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(245, 166, 66, 0.30)',
      borderRadius: '2px',
    });
    this._entries = [];
    this._timer = null;
    this._cache = new Map();
    this._enabled = true;
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._enabled) {
      this.clear();
    }
  }

  ingestBatch(batch, activeSourceUri) {
    if (!this._enabled || !batch || !Array.isArray(batch.events) || batch.events.length === 0) {
      return;
    }
    const targetEditors = vscode.window.visibleTextEditors.filter((editor) => {
      if (!isStrudelDocument(editor.document)) return false;
      if (activeSourceUri && editor.document.uri.toString() !== activeSourceUri) {
        return false;
      }
      return true;
    });
    if (targetEditors.length === 0) return;

    const nowMs = Date.now();
    const deviceTime = typeof batch.device_time === 'number' ? batch.device_time : 0;
    const expectedRevision = typeof batch.source_revision === 'string' ? batch.source_revision : null;

    for (const editor of targetEditors) {
      const doc = editor.document;
      const meta = this._documentMeta(doc);
      if (expectedRevision && meta.revision !== expectedRevision) {
        continue;
      }
      const uriKey = doc.uri.toString();

      for (const event of batch.events) {
        if (!event || !Array.isArray(event.context) || event.context.length === 0) continue;
        const targetTime = typeof event.target_time === 'number' ? event.target_time : deviceTime;
        const delayMs = Math.max(0, Math.min(2000, (targetTime - deviceTime) * 1000));
        const durSec = typeof event.duration_secs === 'number' ? event.duration_secs : 0.12;
        const durMs = Math.max(65, Math.min(450, durSec * 1000));
        const startMs = nowMs + delayMs;
        const endMs = startMs + durMs;

        for (const span of event.context) {
          if (!Array.isArray(span) || span.length < 2) continue;
          const from16 = meta.mapByte(span[0]);
          const to16 = meta.mapByte(span[1]);
          if (to16 <= from16) continue;
          const range = new vscode.Range(doc.positionAt(from16), doc.positionAt(to16));
          this._entries.push({ uriKey, startMs, endMs, range });
        }
      }
    }

    if (this._entries.length > MAX_ACTIVE_HIGHLIGHTS) {
      this._entries.splice(0, this._entries.length - MAX_ACTIVE_HIGHLIGHTS);
    }

    if (this._entries.length > 0 && !this._timer) {
      this._timer = setInterval(() => this._tick(), HIGHLIGHT_TICK_MS);
    }
  }

  clear() {
    this._entries.length = 0;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._decoration, []);
    }
  }

  dispose() {
    this.clear();
    this._cache.clear();
    this._decoration.dispose();
  }

  _documentMeta(doc) {
    const uriKey = doc.uri.toString();
    const cached = this._cache.get(uriKey);
    if (cached && cached.version === doc.version) {
      return cached;
    }
    const text = doc.getText();
    const meta = {
      version: doc.version,
      revision: sha256Hex(text),
      mapByte: buildUtf8ToUtf16Mapper(text),
    };
    if (this._cache.size > 32) {
      this._cache.clear();
    }
    this._cache.set(uriKey, meta);
    return meta;
  }

  _tick() {
    const nowMs = Date.now();
    const byUri = new Map();
    const remaining = [];

    for (const entry of this._entries) {
      if (entry.endMs <= nowMs) continue;
      remaining.push(entry);
      if (entry.startMs <= nowMs) {
        let list = byUri.get(entry.uriKey);
        if (!list) {
          list = [];
          byUri.set(entry.uriKey, list);
        }
        list.push(entry.range);
      }
    }

    this._entries = remaining;
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = byUri.get(editor.document.uri.toString()) || [];
      editor.setDecorations(this._decoration, ranges);
    }

    if (this._entries.length === 0 && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Rustel');
  const diagnostics = vscode.languages.createDiagnosticCollection('rustel');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  highlighter = new EventHighlighter();

  let missingBinaryNotified = false;
  let config = readConfig();
  highlighter.setEnabled(config.highlightEvents);

  function log(line) {
    output.appendLine(line);
  }

  function notifyMissingBinary(serverPath) {
    if (missingBinaryNotified) return;
    missingBinaryNotified = true;
    vscode.window
      .showWarningMessage(
        `Could not start "${serverPath}". Install Rustel or set rustel.serverPath in settings.`,
        'Open Settings',
        'Show Output'
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'rustel.serverPath');
        } else if (choice === 'Show Output') {
          output.show(true);
        }
      });
  }

  function updateStatusBar() {
    const isPlaying = player && player.state === PlayState.PLAYING;
    const lspState = lspClient ? lspClient.state : LspState.STOPPED;
    vscode.commands.executeCommand('setContext', 'rustel.isPlaying', Boolean(isPlaying));

    if (isPlaying) {
      statusBar.text = `$(debug-stop) Rustel: ${player.activeLabel || 'Playing'}`;
      statusBar.tooltip = 'Click to stop Rustel playback (Ctrl+.)';
      statusBar.command = 'rustel.stop';
      statusBar.show();
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const onStrudel = activeEditor && isStrudelDocument(activeEditor.document);

    if (lspState === LspState.RUNNING) {
      statusBar.text = '$(play) Rustel';
      statusBar.tooltip = 'Rustel LSP ready. Click or press Ctrl+Enter to play.';
      statusBar.command = onStrudel ? 'rustel.play' : 'rustel.showOutput';
    } else if (lspState === LspState.STARTING) {
      statusBar.text = '$(sync~spin) Rustel';
      statusBar.tooltip = 'Starting Rustel language server...';
      statusBar.command = 'rustel.showOutput';
    } else {
      statusBar.text = '$(warning) Rustel';
      statusBar.tooltip = 'Rustel language server stopped. Click to view output.';
      statusBar.command = 'rustel.showOutput';
    }

    if (onStrudel || lspState === LspState.RUNNING) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  }

  function collectOpenStrudelDocs() {
    return vscode.workspace.textDocuments
      .filter(isStrudelDocument)
      .map((doc) => ({
        uri: doc.uri.toString(),
        languageId: doc.languageId,
        version: doc.version,
        text: doc.getText(),
      }));
  }

  const extVersion =
    (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) ||
    '0.1.0';

  lspClient = new RustelLspClient({
    serverPath: config.serverPath,
    clientVersion: extVersion,
    trace: config.trace,
    onLog: log,
    onDiagnostics: (uri, lspDiags) => {
      try {
        diagnostics.set(vscode.Uri.parse(uri), toVsCodeDiagnostics(lspDiags));
      } catch (err) {
        log(`[lsp] invalid diagnostic URI "${uri}": ${err.message}`);
      }
    },
    onStateChange: (state, detail) => {
      if (detail && detail.error === 'not-found') {
        notifyMissingBinary(detail.serverPath || config.serverPath);
      }
      updateStatusBar();
    },
  });

  player = new RustelPlayer({
    serverPath: config.serverPath,
    trace: config.trace,
    onLog: log,
    onLayout: () => {
      highlighter.clear();
    },
    onEvents: (batch) => {
      highlighter.ingestBatch(batch, player.activeSourceUri);
    },
    onPlaybackError: (message) => {
      vscode.window.showErrorMessage(`Rustel: ${message}`);
    },
    onStateChange: (state, detail) => {
      if (state === PlayState.STOPPED) {
        highlighter.clear();
      }
      if (detail && detail.error === 'not-found') {
        notifyMissingBinary(detail.serverPath || config.serverPath);
      }
      updateStatusBar();
    },
  });

  function ensureLspStarted() {
    if (!lspClient || lspClient.state !== LspState.STOPPED) return;
    lspClient.start(collectOpenStrudelDocs).catch((err) => {
      log(`[lsp] startup failed: ${err.message}`);
    });
  }

  // Sync open, edit, and close events with `rustel lsp --stdio`.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isStrudelDocument(doc)) return;
      if (lspClient.state === LspState.STOPPED) {
        ensureLspStarted();
      } else {
        lspClient.didOpen(doc.uri.toString(), doc.languageId, doc.version, doc.getText());
      }
      updateStatusBar();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isStrudelDocument(event.document)) return;
      lspClient.didChange(
        event.document.uri.toString(),
        event.document.version,
        event.document.getText()
      );
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!isStrudelDocument(doc)) return;
      diagnostics.delete(doc.uri);
      lspClient.didClose(doc.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatusBar();
    })
  );

  // LSP completion and hover providers.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      STRUDEL_SELECTOR,
      {
        async provideCompletionItems(document, position) {
          if (lspClient.state !== LspState.RUNNING) return [];
          const list = await lspClient.completion(
            document.uri.toString(),
            position.line,
            position.character
          );
          return new vscode.CompletionList(
            list.items.map(toVsCodeCompletionItem),
            list.isIncomplete
          );
        },
      },
      '.',
      '"',
      "'"
    ),
    vscode.languages.registerHoverProvider(STRUDEL_SELECTOR, {
      async provideHover(document, position) {
        if (lspClient.state !== LspState.RUNNING) return null;
        const result = await lspClient.hover(
          document.uri.toString(),
          position.line,
          position.character
        );
        if (!result || !result.contents) return null;
        const raw =
          typeof result.contents === 'string'
            ? result.contents
            : typeof result.contents.value === 'string'
              ? result.contents.value
              : null;
        if (!raw) return null;
        const md = new vscode.MarkdownString(raw);
        md.isTrusted = false;
        const range = result.range ? mapLspRange(result.range) : undefined;
        return new vscode.Hover(md, range);
      },
    }),
    vscode.languages.registerSignatureHelpProvider(
      STRUDEL_SELECTOR,
      {
        async provideSignatureHelp(document, position) {
          if (lspClient.state !== LspState.RUNNING) return null;
          const result = await lspClient.signatureHelp(
            document.uri.toString(),
            position.line,
            position.character
          );
          if (!result || !Array.isArray(result.signatures) || result.signatures.length === 0) {
            return null;
          }
          const help = new vscode.SignatureHelp();
          help.signatures = result.signatures.map((sig) => {
            const info = new vscode.SignatureInformation(
              typeof sig.label === 'string' ? sig.label : ''
            );
            if (sig.documentation) {
              const docVal =
                typeof sig.documentation === 'string'
                  ? sig.documentation
                  : typeof sig.documentation.value === 'string'
                    ? sig.documentation.value
                    : null;
              if (docVal) {
                const md = new vscode.MarkdownString(docVal);
                md.isTrusted = false;
                info.documentation = md;
              }
            }
            if (Array.isArray(sig.parameters)) {
              info.parameters = sig.parameters.map((param) => {
                let pdoc;
                if (param.documentation) {
                  const val =
                    typeof param.documentation === 'string'
                      ? param.documentation
                      : typeof param.documentation.value === 'string'
                        ? param.documentation.value
                        : null;
                  if (val) {
                    const md = new vscode.MarkdownString(val);
                    md.isTrusted = false;
                    pdoc = md;
                  }
                }
                return new vscode.ParameterInformation(
                  typeof param.label === 'string' ? param.label : '',
                  pdoc
                );
              });
            }
            return info;
          });
          help.activeSignature =
            typeof result.activeSignature === 'number' ? result.activeSignature : 0;
          help.activeParameter =
            typeof result.activeParameter === 'number' ? result.activeParameter : 0;
          return help;
        },
      },
      '(',
      ','
    )
  );

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('rustel.play', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isStrudelDocument(editor.document)) {
        vscode.window.showInformationMessage('Open a .strudel file to play with Rustel.');
        return;
      }
      const doc = editor.document;
      if (doc.uri.scheme === 'file') {
        if (doc.isDirty) {
          const saved = await doc.save();
          if (!saved) return;
        }
        await player.playFile(doc.uri.fsPath, {
          sourceUri: doc.uri.toString(),
          label: path.basename(doc.uri.fsPath),
          cwd: path.dirname(doc.uri.fsPath),
          extraArgs: config.extraPlayArgs,
        });
      } else {
        await player.playSnippet(doc.getText(), {
          sourceUri: doc.uri.toString(),
          label: path.basename(doc.fileName) || 'untitled',
          extraArgs: config.extraPlayArgs,
        });
      }
    }),

    vscode.commands.registerCommand('rustel.playSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isStrudelDocument(editor.document)) {
        vscode.window.showInformationMessage('Open a .strudel file to play a selection.');
        return;
      }
      const doc = editor.document;
      const selection = editor.selection;
      const text = selection.isEmpty
        ? doc.lineAt(selection.active.line).text
        : doc.getText(selection);
      if (!text.trim()) return;
      const cwd = doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined;
      await player.playSnippet(text, {
        sourceUri: null,
        label: 'selection',
        cwd,
        extraArgs: config.extraPlayArgs,
      });
    }),

    vscode.commands.registerCommand('rustel.stop', async () => {
      await player.stop();
    }),

    vscode.commands.registerCommand('rustel.restartServer', async () => {
      missingBinaryNotified = false;
      diagnostics.clear();
      await lspClient.stop();
      ensureLspStarted();
    }),

    vscode.commands.registerCommand('rustel.showOutput', () => {
      output.show(true);
    })
  );

  // React to settings changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('rustel')) return;
      const next = readConfig();
      const pathChanged = next.serverPath !== config.serverPath;
      config = next;
      lspClient.configure({ serverPath: config.serverPath, trace: config.trace });
      player.configure({ serverPath: config.serverPath, trace: config.trace });
      highlighter.setEnabled(config.highlightEvents);
      if (pathChanged) {
        missingBinaryNotified = false;
        diagnostics.clear();
        await lspClient.stop();
        ensureLspStarted();
      }
    })
  );

  context.subscriptions.push(output, diagnostics, statusBar, highlighter);

  // Start immediately if a Strudel score is already open.
  if (vscode.workspace.textDocuments.some(isStrudelDocument)) {
    ensureLspStarted();
  }
  updateStatusBar();
}

async function deactivate() {
  if (highlighter) {
    highlighter.clear();
  }
  const tasks = [];
  if (player) {
    tasks.push(player.stop());
  }
  if (lspClient) {
    tasks.push(lspClient.stop());
  }
  await Promise.allSettled(tasks);
}

module.exports = {
  activate,
  deactivate,
};
