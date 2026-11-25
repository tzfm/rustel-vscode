'use strict';

const crypto = require('crypto');

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 2 * 1024 * 1024;

/**
 * Encode one JSON-RPC message using LSP Content-Length framing.
 * @param {object} message
 * @returns {Buffer}
 */
function encodeLspMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Find the end of the LSP header section in a buffer.
 * Supports standard CRLFCRLF and falls back to LFLF defensively.
 * @param {Buffer} buf
 * @returns {{ end: number, sepLen: number } | null}
 */
function findHeaderBoundary(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { end: crlf, sepLen: 4 };
  }
  if (lf !== -1) {
    return { end: lf, sepLen: 2 };
  }
  return null;
}

/**
 * Parse Content-Length from an ASCII header block.
 * @param {string} headerText
 * @returns {number | null}
 */
function parseContentLength(headerText) {
  const lines = headerText.split(/\r?\n/);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name !== 'content-length') continue;
    const raw = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(raw)) return null;
    const length = Number(raw);
    if (!Number.isSafeInteger(length)) return null;
    return length;
  }
  return null;
}

/**
 * Incremental, bounded LSP Content-Length frame reader.
 */
class LspMessageReader {
  /**
   * @param {(message: object) => void} onMessage
   * @param {(err: Error) => void} [onError]
   */
  constructor(onMessage, onError) {
    this._onMessage = onMessage;
    this._onError = onError || (() => {});
    this._buffer = Buffer.alloc(0);
    this._expectedLength = null;
  }

  /**
   * Feed raw bytes from the LSP server stdout.
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk]);

    while (true) {
      if (this._expectedLength === null) {
        const boundary = findHeaderBoundary(this._buffer);
        if (!boundary) {
          if (this._buffer.length > MAX_HEADER_BYTES) {
            this._resetWithError(new Error('LSP header exceeded maximum size'));
          }
          return;
        }
        if (boundary.end > MAX_HEADER_BYTES) {
          this._resetWithError(new Error('LSP header exceeded maximum size'));
          return;
        }
        const headerText = this._buffer.slice(0, boundary.end).toString('ascii');
        const length = parseContentLength(headerText);
        this._buffer = this._buffer.slice(boundary.end + boundary.sepLen);
        if (length === null || length > MAX_FRAME_BYTES) {
          this._resetWithError(new Error('Invalid or oversized LSP Content-Length header'));
          return;
        }
        this._expectedLength = length;
      }

      if (this._buffer.length < this._expectedLength) {
        return;
      }

      const body = this._buffer.slice(0, this._expectedLength);
      this._buffer = this._buffer.slice(this._expectedLength);
      this._expectedLength = null;

      try {
        const parsed = JSON.parse(body.toString('utf8'));
        this._onMessage(parsed);
      } catch (err) {
        this._onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  _resetWithError(err) {
    this._buffer = Buffer.alloc(0);
    this._expectedLength = null;
    this._onError(err);
  }
}

/**
 * Incremental, bounded NDJSON line reader for rustel play stdout and stderr.
 */
class NdjsonReader {
  /**
   * @param {(rawLine: string, parsed: object | null) => void} onLine
   * @param {(err: Error) => void} [onError]
   */
  constructor(onLine, onError) {
    this._onLine = onLine;
    this._onError = onError || (() => {});
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Feed raw bytes from a child process stream.
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk]);

    let newlineIndex = this._buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const slice = this._buffer.slice(0, newlineIndex);
      this._buffer = this._buffer.slice(newlineIndex + 1);
      this._emitLine(slice);
      newlineIndex = this._buffer.indexOf(0x0a);
    }

    if (this._buffer.length > MAX_NDJSON_LINE_BYTES) {
      this._buffer = Buffer.alloc(0);
      this._onError(new Error('NDJSON line exceeded maximum size'));
    }
  }

  flush() {
    if (this._buffer.length === 0) return;
    const tail = this._buffer;
    this._buffer = Buffer.alloc(0);
    this._emitLine(tail);
  }

  _emitLine(buf) {
    const raw = buf.toString('utf8').replace(/\r$/, '').trim();
    if (raw.length === 0) return;
    let parsed = null;
    if (raw.startsWith('{')) {
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = null;
      }
    }
    this._onLine(raw, parsed);
  }
}

/**
 * Compute lowercase SHA-256 hex matching rustel_runtime::ui_events::source_revision.
 * @param {string} text
 * @returns {string}
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build a mapper from UTF-8 byte offsets (Rustel ui_events) to UTF-16 code unit offsets (VS Code).
 * Pure ASCII documents use an O(1) identity fast path.
 * @param {string} text
 * @returns {(byteOffset: number) => number}
 */
function buildUtf8ToUtf16Mapper(text) {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes === text.length) {
    return (byteOffset) => {
      if (byteOffset <= 0) return 0;
      if (byteOffset >= text.length) return text.length;
      return byteOffset;
    };
  }

  const table = new Int32Array(totalBytes + 1);
  let bytePos = 0;
  let u16Pos = 0;

  while (u16Pos < text.length) {
    const cp = text.codePointAt(u16Pos);
    let utf8Len = 1;
    let u16Len = 1;
    if (cp <= 0x7f) {
      utf8Len = 1;
    } else if (cp <= 0x7ff) {
      utf8Len = 2;
    } else if (cp <= 0xffff) {
      utf8Len = 3;
    } else {
      utf8Len = 4;
      u16Len = 2;
    }
    for (let i = 0; i < utf8Len; i++) {
      table[bytePos + i] = u16Pos;
    }
    bytePos += utf8Len;
    u16Pos += u16Len;
  }
  table[totalBytes] = text.length;

  return (byteOffset) => {
    if (byteOffset <= 0) return 0;
    if (byteOffset >= totalBytes) return text.length;
    return table[byteOffset];
  };
}

module.exports = {
  MAX_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_NDJSON_LINE_BYTES,
  encodeLspMessage,
  LspMessageReader,
  NdjsonReader,
  sha256Hex,
  buildUtf8ToUtf16Mapper,
};
