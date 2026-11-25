'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeLspMessage,
  LspMessageReader,
  NdjsonReader,
  sha256Hex,
  buildUtf8ToUtf16Mapper,
  MAX_FRAME_BYTES,
} = require('../src/protocol');

test('LspMessageReader handles split multi-byte UTF-8 chunks and back-to-back frames', () => {
  const received = [];
  const errors = [];
  const reader = new LspMessageReader(
    (msg) => received.push(msg),
    (err) => errors.push(err)
  );

  const first = { jsonrpc: '2.0', id: 1, result: { label: 'cafe \u00e9 \u{1F3B5}' } };
  const second = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.strudel', diagnostics: [] } };
  const combined = Buffer.concat([encodeLspMessage(first), encodeLspMessage(second)]);

  // Feed 3 bytes at a time to split headers and multi-byte UTF-8 sequences.
  for (let i = 0; i < combined.length; i += 3) {
    reader.push(combined.slice(i, i + 3));
  }

  assert.equal(errors.length, 0);
  assert.deepEqual(received, [first, second]);
});

test('LspMessageReader rejects oversized Content-Length headers safely', () => {
  const received = [];
  const errors = [];
  const reader = new LspMessageReader(
    (msg) => received.push(msg),
    (err) => errors.push(err)
  );

  const oversized = Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n{}`, 'ascii');
  reader.push(oversized);

  assert.equal(received.length, 0);
  assert.equal(errors.length, 1);

  // Reader recovers cleanly for subsequent valid messages.
  const valid = { jsonrpc: '2.0', id: 2, result: null };
  reader.push(encodeLspMessage(valid));
  assert.deepEqual(received, [valid]);
});

test('NdjsonReader parses split JSON records and plain stderr lines', () => {
  const lines = [];
  const reader = new NdjsonReader((raw, parsed) => lines.push({ raw, parsed }));

  const chunk = Buffer.from(
    '{"ui_events":{"version":2,"events":[]}}\r\nUpdated song.strudel\n{"live_error":{"message":"bad"}}',
    'utf8'
  );
  reader.push(chunk.slice(0, 15));
  reader.push(chunk.slice(15));
  reader.flush();

  assert.equal(lines.length, 3);
  assert.equal(lines[0].parsed.ui_events.version, 2);
  assert.equal(lines[1].raw, 'Updated song.strudel');
  assert.equal(lines[1].parsed, null);
  assert.equal(lines[2].parsed.live_error.message, 'bad');
});

test('buildUtf8ToUtf16Mapper maps ASCII and supplementary Unicode byte offsets accurately', () => {
  const ascii = 's("bd sd")';
  const mapAscii = buildUtf8ToUtf16Mapper(ascii);
  assert.equal(mapAscii(3), 3);
  assert.equal(mapAscii(99), ascii.length);

  // "// 🎵\ns(\"bd\")" -> 🎵 is 4 UTF-8 bytes and 2 UTF-16 code units.
  const unicode = '// \u{1F3B5}\ns("bd")';
  const mapUni = buildUtf8ToUtf16Mapper(unicode);
  const sByteOffset = Buffer.byteLength('// \u{1F3B5}\n', 'utf8');
  const sUtf16Offset = '// \u{1F3B5}\n'.length;
  assert.equal(sByteOffset, 8);
  assert.equal(sUtf16Offset, 6);
  assert.equal(mapUni(sByteOffset), sUtf16Offset);
  assert.equal(mapUni(sByteOffset + 3), sUtf16Offset + 3);
});

test('sha256Hex returns lowercase 64-character hex digest', () => {
  const digest = sha256Hex('s("bd")');
  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]{64}$/);
});
