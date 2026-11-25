'use strict';

const { spawn } = require('child_process');
const { encodeLspMessage, LspMessageReader } = require('./protocol');

const LspState = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
});

const MAX_PENDING_REQUESTS = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 800;

/**
 * Zero-dependency stdio LSP client for `rustel lsp --stdio`.
 */
class RustelLspClient {
  /**
   * @param {object} options
   * @param {string} [options.serverPath]
   * @param {string[]} [options.serverArgs]
   * @param {string} [options.clientVersion]
   * @param {number} [options.requestTimeoutMs]
   * @param {'off' | 'messages'} [options.trace]
   * @param {(uri: string, diagnostics: object[]) => void} [options.onDiagnostics]
   * @param {(state: string, detail?: object) => void} [options.onStateChange]
   * @param {(line: string) => void} [options.onLog]
   * @param {typeof spawn} [options.spawnFn]
   */
  constructor(options = {}) {
    this._serverPath = options.serverPath || 'rustel';
    this._serverArgs = options.serverArgs || ['lsp', '--stdio'];
    this._clientVersion = options.clientVersion || '0.1.0';
    this._requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this._trace = options.trace || 'off';
    this._onDiagnostics = options.onDiagnostics || (() => {});
    this._onStateChange = options.onStateChange || (() => {});
    this._onLog = options.onLog || (() => {});
    this._spawnFn = options.spawnFn || spawn;

    this._state = LspState.STOPPED;
    this._child = null;
    this._reader = null;
    this._nextId = 1;
    this._pending = new Map();
    this._startPromise = null;
    this._serverInfo = null;
  }

  get state() {
    return this._state;
  }

  get serverInfo() {
    return this._serverInfo;
  }

  /**
   * Update live settings without recreating the client instance.
   * @param {{ serverPath?: string, trace?: 'off' | 'messages' }} config
   */
  configure(config) {
    if (typeof config.serverPath === 'string' && config.serverPath.trim()) {
      this._serverPath = config.serverPath.trim();
    }
    if (config.trace === 'off' || config.trace === 'messages') {
      this._trace = config.trace;
    }
  }

  /**
   * Start `rustel lsp --stdio`, complete the initialize handshake, and sync open documents.
   * @param {() => Array<{ uri: string, languageId: string, version: number, text: string }>} [getOpenDocs]
   * @returns {Promise<object>}
   */
  start(getOpenDocs) {
    if (this._state === LspState.RUNNING) {
      return Promise.resolve(this._serverInfo || {});
    }
    if (this._state === LspState.STARTING && this._startPromise) {
      return this._startPromise;
    }

    this._setState(LspState.STARTING);
    this._startPromise = this._startInternal(getOpenDocs).finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _startInternal(getOpenDocs) {
    let child;
    try {
      child = this._spawnFn(this._serverPath, this._serverArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._setState(LspState.STOPPED, {
        error: err && err.code === 'ENOENT' ? 'not-found' : 'spawn-error',
        message: err ? err.message : 'failed to start server',
        serverPath: this._serverPath,
      });
      throw err;
    }

    this._child = child;
    this._reader = new LspMessageReader(
      (msg) => this._handleMessage(msg),
      (err) => this._onLog(`[lsp] protocol error: ${err.message}`)
    );

    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
      const missing = err && err.code === 'ENOENT';
      this._onLog(`[lsp] process error: ${err.message}`);
      this._rejectAllPending(err);
      this._cleanupChildRef(child);
      this._setState(LspState.STOPPED, {
        error: missing ? 'not-found' : 'process-error',
        message: err.message,
        serverPath: this._serverPath,
      });
    });

    child.stdout.on('data', (chunk) => {
      if (this._child === child && this._reader) {
        this._reader.push(chunk);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this._onLog(`[lsp stderr] ${text}`);
      }
    });

    child.on('exit', (code, signal) => {
      if (this._child !== child) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this._onLog(`[lsp] exited (${reason})`);
      this._rejectAllPending(new Error(`LSP server exited (${reason})`));
      this._cleanupChildRef(child);
      if (this._state !== LspState.STOPPED) {
        this._setState(LspState.STOPPED, {
          error: spawnError && spawnError.code === 'ENOENT' ? 'not-found' : undefined,
          code,
          signal,
        });
      }
    });

    const initParams = {
      processId: process.pid,
      rootUri: null,
      clientInfo: {
        name: 'rustel-vscode',
        version: this._clientVersion,
      },
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: false,
            willSave: false,
          },
          completion: {
            completionItem: {
              snippetSupport: false,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
            },
          },
          hover: {
            contentFormat: ['markdown', 'plaintext'],
          },
          publishDiagnostics: {},
        },
      },
    };

    try {
      const result = await this._sendRequestRaw('initialize', initParams, this._requestTimeoutMs);
      if (this._child !== child || this._state !== LspState.STARTING) {
        throw new Error('LSP startup aborted');
      }
      this._serverInfo = (result && result.serverInfo) || { name: 'rustel' };
      this._sendNotificationRaw('initialized', {});
      this._setState(LspState.RUNNING, { serverInfo: this._serverInfo });
      this._onLog(
        `[lsp] ready (${this._serverInfo.name || 'rustel'} ${this._serverInfo.version || ''})`.trim()
      );

      if (typeof getOpenDocs === 'function') {
        for (const doc of getOpenDocs()) {
          this.didOpen(doc.uri, doc.languageId, doc.version, doc.text);
        }
      }
      return result;
    } catch (err) {
      if (this._child === child) {
        try {
          child.kill();
        } catch (_) {}
        this._cleanupChildRef(child);
      }
      if (this._state !== LspState.STOPPED) {
        this._setState(LspState.STOPPED, {
          error: err && err.code === 'ENOENT' ? 'not-found' : 'init-failed',
          message: err ? err.message : 'initialize failed',
          serverPath: this._serverPath,
        });
      }
      throw err;
    }
  }

  /**
   * Gracefully shut down the language server.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._state === LspState.STOPPED) {
      return;
    }
    const child = this._child;
    this._setState(LspState.STOPPING);
    this._rejectAllPending(new Error('LSP server stopping'));

    if (child) {
      try {
        await this._sendRequestRaw('shutdown', null, SHUTDOWN_TIMEOUT_MS);
        this._sendNotificationRaw('exit', null);
      } catch (_) {
        // Proceed to close stdio and terminate child cleanly.
      }
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch (_) {}

      await new Promise((resolve) => {
        if (child.exitCode !== null || child.killed) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch (_) {}
          resolve();
        }, 400);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this._cleanupChildRef(child);
    }

    this._setState(LspState.STOPPED);
  }

  didOpen(uri, languageId, version, text) {
    if (this._state !== LspState.RUNNING) return;
    this._sendNotificationRaw('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  didChange(uri, version, text) {
    if (this._state !== LspState.RUNNING) return;
    this._sendNotificationRaw('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri) {
    if (this._state !== LspState.RUNNING) return;
    this._sendNotificationRaw('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /**
   * Request completion items at a UTF-16 position.
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @returns {Promise<{ isIncomplete: boolean, items: object[] }>}
   */
  async completion(uri, line, character) {
    if (this._state !== LspState.RUNNING) {
      return { isIncomplete: false, items: [] };
    }
    try {
      const result = await this._sendRequestRaw(
        'textDocument/completion',
        {
          textDocument: { uri },
          position: { line, character },
        },
        this._requestTimeoutMs
      );
      if (Array.isArray(result)) {
        return { isIncomplete: false, items: result };
      }
      if (result && Array.isArray(result.items)) {
        return { isIncomplete: Boolean(result.isIncomplete), items: result.items };
      }
      return { isIncomplete: false, items: [] };
    } catch (err) {
      this._onLog(`[lsp] completion failed: ${err.message}`);
      return { isIncomplete: false, items: [] };
    }
  }

  /**
   * Request hover documentation at a UTF-16 position.
   * @param {string} uri
   * @param {number} line
   * @param {number} character
   * @returns {Promise<object | null>}
   */
  async hover(uri, line, character) {
    if (this._state !== LspState.RUNNING) {
      return null;
    }
    try {
      return await this._sendRequestRaw(
        'textDocument/hover',
        {
          textDocument: { uri },
          position: { line, character },
        },
        this._requestTimeoutMs
      );
    } catch (err) {
      this._onLog(`[lsp] hover failed: ${err.message}`);
      return null;
    }
  }

  _sendRequestRaw(method, params, timeoutMs) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
      return Promise.reject(new Error('LSP process is not running'));
    }
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Too many pending LSP requests'));
    }

    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });
      try {
        this._write(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _sendNotificationRaw(method, params) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
      return;
    }
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      payload.params = params;
    }
    try {
      this._write(payload);
    } catch (err) {
      this._onLog(`[lsp] failed to send ${method}: ${err.message}`);
    }
  }

  _write(message) {
    if (this._trace === 'messages') {
      this._onLog(`[lsp ->] ${JSON.stringify(message)}`);
    }
    this._child.stdin.write(encodeLspMessage(message));
  }

  _handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (this._trace === 'messages') {
      this._onLog(`[lsp <-] ${JSON.stringify(message)}`);
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const hasMethod = typeof message.method === 'string';

    if (hasId && !hasMethod) {
      const entry = this._pending.get(message.id);
      if (!entry) return;
      this._pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message || 'LSP request error'));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (hasMethod && hasId) {
      // Reply cleanly to any unexpected server-to-client request.
      try {
        this._write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unsupported client method: ${message.method}` },
        });
      } catch (_) {}
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics' && message.params) {
      const uri = message.params.uri;
      const diagnostics = Array.isArray(message.params.diagnostics)
        ? message.params.diagnostics
        : [];
      if (typeof uri === 'string') {
        this._onDiagnostics(uri, diagnostics);
      }
    }
  }

  _rejectAllPending(err) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  _cleanupChildRef(child) {
    if (this._child === child) {
      this._child = null;
      this._reader = null;
      this._serverInfo = null;
    }
  }

  _setState(next, detail) {
    if (this._state === next && !detail) return;
    this._state = next;
    this._onStateChange(next, detail);
  }
}

module.exports = {
  LspState,
  RustelLspClient,
};
