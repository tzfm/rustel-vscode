'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NdjsonReader } = require('./protocol');

const PlayState = Object.freeze({
  STOPPED: 'stopped',
  PLAYING: 'playing',
  STOPPING: 'stopping',
});

/**
 * Manages live playback through `rustel play <file> --watch --ui-events`.
 */
class RustelPlayer {
  /**
   * @param {object} options
   * @param {string} [options.serverPath]
   * @param {'off' | 'messages'} [options.trace]
   * @param {(state: string, info?: object) => void} [options.onStateChange]
   * @param {(layout: object) => void} [options.onLayout]
   * @param {(batch: object) => void} [options.onEvents]
   * @param {(message: string) => void} [options.onPlaybackError]
   * @param {(line: string) => void} [options.onLog]
   * @param {typeof spawn} [options.spawnFn]
   */
  constructor(options = {}) {
    this._serverPath = options.serverPath || 'rustel';
    this._trace = options.trace || 'off';
    this._onStateChange = options.onStateChange || (() => {});
    this._onLayout = options.onLayout || (() => {});
    this._onEvents = options.onEvents || (() => {});
    this._onPlaybackError = options.onPlaybackError || (() => {});
    this._onLog = options.onLog || (() => {});
    this._spawnFn = options.spawnFn || spawn;

    this._state = PlayState.STOPPED;
    this._child = null;
    this._activePath = null;
    this._activeLabel = null;
    this._activeSourceUri = null;
    this._tempPath = null;
  }

  get state() {
    return this._state;
  }

  get activePath() {
    return this._activePath;
  }

  get activeSourceUri() {
    return this._activeSourceUri;
  }

  get activeLabel() {
    return this._activeLabel;
  }

  /**
   * Update live configuration values.
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
   * Start playing a score file on disk, or rely on `--watch` if already playing it.
   * @param {string} filePath
   * @param {{ sourceUri?: string, label?: string, cwd?: string, extraArgs?: string[] }} [opts]
   * @returns {Promise<{ started: boolean, reloaded: boolean }>}
   */
  async playFile(filePath, opts = {}) {
    if (
      this._state === PlayState.PLAYING &&
      this._activePath === filePath &&
      !this._tempPath
    ) {
      return { started: false, reloaded: true };
    }

    await this.stop();
    this._spawnPlayer(filePath, {
      sourceUri: opts.sourceUri || null,
      label: opts.label || path.basename(filePath),
      cwd: opts.cwd || path.dirname(filePath),
      extraArgs: opts.extraArgs || [],
      isTemp: false,
    });
    return { started: true, reloaded: false };
  }

  /**
   * Play an untitled buffer or selected snippet through a private temporary `.strudel` file.
   * Updating the same selection mode rewrites the watched file without restarting audio.
   * @param {string} text
   * @param {{ sourceUri?: string, label?: string, cwd?: string, extraArgs?: string[] }} [opts]
   * @returns {Promise<{ started: boolean, reloaded: boolean }>}
   */
  async playSnippet(text, opts = {}) {
    if (this._state === PlayState.PLAYING && this._tempPath) {
      fs.writeFileSync(this._tempPath, text, { encoding: 'utf8', mode: 0o600 });
      this._activeSourceUri = opts.sourceUri || this._activeSourceUri;
      this._activeLabel = opts.label || this._activeLabel;
      return { started: false, reloaded: true };
    }

    await this.stop();
    const tempFile = path.join(
      os.tmpdir(),
      `rustel-vscode-${process.pid}-${Date.now()}.strudel`
    );
    fs.writeFileSync(tempFile, text, { encoding: 'utf8', mode: 0o600 });
    this._tempPath = tempFile;
    this._spawnPlayer(tempFile, {
      sourceUri: opts.sourceUri || null,
      label: opts.label || 'selection',
      cwd: opts.cwd || os.tmpdir(),
      extraArgs: opts.extraArgs || [],
      isTemp: true,
    });
    return { started: true, reloaded: false };
  }

  /**
   * Send one inbound `ui_control` record over stdin.
   * @param {object} control
   * @returns {boolean}
   */
  sendControl(control) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
      return false;
    }
    const envelope = { ui_control: Object.assign({ version: 1 }, control) };
    const line = JSON.stringify(envelope) + '\n';
    if (this._trace === 'messages') {
      this._onLog(`[play ->] ${line.trim()}`);
    }
    try {
      this._child.stdin.write(line, 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Stop playback cleanly and remove any temporary score file.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._state === PlayState.STOPPED && !this._child) {
      this._cleanupTempFile();
      return;
    }

    const child = this._child;
    this._setState(PlayState.STOPPING);

    if (child) {
      this.sendControl({ kind: 'transport', action: 'stop' });
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
        }, 600);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (this._child === child) {
        this._child = null;
      }
    }

    this._activePath = null;
    this._activeLabel = null;
    this._activeSourceUri = null;
    this._cleanupTempFile();
    this._setState(PlayState.STOPPED);
  }

  _spawnPlayer(filePath, opts) {
    const args = ['play', filePath, '--watch', '--ui-events'].concat(opts.extraArgs || []);
    this._onLog(`[play] starting: ${this._serverPath} ${args.join(' ')}`);

    let child;
    try {
      child = this._spawnFn(this._serverPath, args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._cleanupTempFile();
      this._setState(PlayState.STOPPED, {
        error: err && err.code === 'ENOENT' ? 'not-found' : 'spawn-error',
        message: err ? err.message : 'failed to start rustel play',
        serverPath: this._serverPath,
      });
      return;
    }

    this._child = child;
    this._activePath = filePath;
    this._activeLabel = opts.label;
    this._activeSourceUri = opts.sourceUri;
    this._setState(PlayState.PLAYING, {
      filePath,
      label: opts.label,
      sourceUri: opts.sourceUri,
    });

    const stdoutReader = new NdjsonReader(
      (raw, parsed) => {
        if (this._child !== child) return;
        if (this._trace === 'messages') {
          this._onLog(`[play <-] ${raw}`);
        }
        if (!parsed || typeof parsed !== 'object') return;
        if (parsed.ui_layout) {
          this._onLayout(parsed.ui_layout);
        } else if (parsed.ui_events) {
          this._onEvents(parsed.ui_events);
        }
      },
      (err) => this._onLog(`[play] stdout parse error: ${err.message}`)
    );

    const stderrReader = new NdjsonReader(
      (raw, parsed) => {
        if (this._child !== child) return;
        this._onLog(`[play] ${raw}`);
        if (!parsed || typeof parsed !== 'object') return;
        if (parsed.live_error && typeof parsed.live_error.message === 'string') {
          this._onPlaybackError(parsed.live_error.message);
        } else if (
          parsed.reload &&
          parsed.reload.status === 'rejected' &&
          typeof parsed.reload.message === 'string'
        ) {
          this._onPlaybackError(parsed.reload.message);
        }
      },
      (err) => this._onLog(`[play] stderr parse error: ${err.message}`)
    );

    child.stdout.on('data', (chunk) => stdoutReader.push(chunk));
    child.stderr.on('data', (chunk) => stderrReader.push(chunk));

    child.on('error', (err) => {
      if (this._child !== child) return;
      this._onLog(`[play] process error: ${err.message}`);
      this._child = null;
      this._activePath = null;
      this._activeLabel = null;
      this._activeSourceUri = null;
      this._cleanupTempFile();
      this._setState(PlayState.STOPPED, {
        error: err && err.code === 'ENOENT' ? 'not-found' : 'process-error',
        message: err.message,
        serverPath: this._serverPath,
      });
    });

    child.on('exit', (code, signal) => {
      stdoutReader.flush();
      stderrReader.flush();
      if (this._child !== child) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this._onLog(`[play] stopped (${reason})`);
      this._child = null;
      this._activePath = null;
      this._activeLabel = null;
      this._activeSourceUri = null;
      this._cleanupTempFile();
      if (this._state !== PlayState.STOPPED) {
        this._setState(PlayState.STOPPED, { code, signal });
      }
    });
  }

  _cleanupTempFile() {
    if (!this._tempPath) return;
    const toRemove = this._tempPath;
    this._tempPath = null;
    try {
      fs.unlinkSync(toRemove);
    } catch (_) {}
  }

  _setState(next, detail) {
    if (this._state === next && !detail) return;
    this._state = next;
    this._onStateChange(next, detail);
  }
}

module.exports = {
  PlayState,
  RustelPlayer,
};
