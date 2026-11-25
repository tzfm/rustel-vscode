'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LspState, RustelLspClient } = require('../src/lsp-client');
const { encodeLspMessage, LspMessageReader } = require('../src/protocol');

function createFakeServerSpawn(handler) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };

    const reader = new LspMessageReader((msg) => {
      handler(msg, {
        send: (reply) => child.stdout.write(encodeLspMessage(reply)),
        exit: (code = 0) => {
          child.exitCode = code;
          child.emit('exit', code, null);
        },
      });
    });
    child.stdin.on('data', (chunk) => reader.push(chunk));
    return child;
  };
}

test('RustelLspClient runs full lifecycle: initialize, diagnostics, completion, hover, shutdown', async () => {
  const states = [];
  const diagnostics = [];
  const seenMethods = [];

  const spawnFn = createFakeServerSpawn((msg, io) => {
    seenMethods.push(msg.method);
    switch (msg.method) {
      case 'initialize':
        io.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            capabilities: { textDocumentSync: 1, hoverProvider: true },
            serverInfo: { name: 'rustel', version: 'test' },
          },
        });
        break;
      case 'textDocument/didOpen':
        io.send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: msg.params.textDocument.uri,
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                severity: 2,
                source: 'rustel',
                message: 'example warning',
              },
            ],
          },
        });
        break;
      case 'textDocument/completion':
        io.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            isIncomplete: false,
            items: [{ label: 'lpf', kind: 2, detail: 'lpf(frequency)' }],
          },
        });
        break;
      case 'textDocument/hover':
        io.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: { kind: 'markdown', value: '```js\nlpf(frequency)\n```' },
          },
        });
        break;
      case 'textDocument/signatureHelp':
        io.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            signatures: [
              {
                label: 'euclid(pulses, steps)',
                parameters: [{ label: 'pulses' }, { label: 'steps' }],
              },
            ],
            activeSignature: 0,
            activeParameter: 1,
          },
        });
        break;
      case 'shutdown':
        io.send({ jsonrpc: '2.0', id: msg.id, result: null });
        break;
      case 'exit':
        io.exit(0);
        break;
      default:
        break;
    }
  });

  const client = new RustelLspClient({
    spawnFn,
    onStateChange: (s) => states.push(s),
    onDiagnostics: (uri, diags) => diagnostics.push({ uri, diags }),
  });

  await client.start(() => [
    { uri: 'file:///demo.strudel', languageId: 'strudel', version: 1, text: 's("bd").lpf(800)' },
  ]);

  assert.equal(client.state, LspState.RUNNING);
  assert.deepEqual(client.serverInfo, { name: 'rustel', version: 'test' });

  const comp = await client.completion('file:///demo.strudel', 0, 10);
  assert.equal(comp.items.length, 1);
  assert.equal(comp.items[0].label, 'lpf');

  const hover = await client.hover('file:///demo.strudel', 0, 9);
  assert.match(hover.contents.value, /lpf\(frequency\)/);

  const sig = await client.signatureHelp('file:///demo.strudel', 0, 12);
  assert.equal(sig.signatures[0].label, 'euclid(pulses, steps)');
  assert.equal(sig.activeParameter, 1);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].diags[0].message, 'example warning');

  await client.stop();
  assert.equal(client.state, LspState.STOPPED);
  assert.deepEqual(states, [
    LspState.STARTING,
    LspState.RUNNING,
    LspState.STOPPING,
    LspState.STOPPED,
  ]);
  assert.ok(seenMethods.includes('initialized'));
  assert.ok(seenMethods.includes('shutdown'));
  assert.ok(seenMethods.includes('exit'));
});

test('RustelLspClient reports missing binary cleanly without hanging', async () => {
  const details = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {};
    process.nextTick(() => {
      const err = new Error('spawn rustel ENOENT');
      err.code = 'ENOENT';
      child.emit('error', err);
    });
    return child;
  };

  const client = new RustelLspClient({
    serverPath: 'nonexistent-rustel',
    spawnFn,
    onStateChange: (state, detail) => details.push({ state, detail }),
  });

  await assert.rejects(() => client.start(), /ENOENT/);
  assert.equal(client.state, LspState.STOPPED);
  assert.ok(details.some((d) => d.detail && d.detail.error === 'not-found'));
});

// Optional live integration test when RUSTEL_BIN points to a built rustel binary.
test('live rustel lsp --stdio roundtrip (optional via RUSTEL_BIN)', { skip: !process.env.RUSTEL_BIN }, async () => {
  const diags = [];
  const client = new RustelLspClient({
    serverPath: process.env.RUSTEL_BIN,
    onDiagnostics: (uri, list) => diags.push({ uri, list }),
  });

  await client.start(() => [
    { uri: 'file:///live.strudel', languageId: 'strudel', version: 1, text: 'note("c4").s("si").lpf(800)' },
  ]);

  const hover = await client.hover('file:///live.strudel', 0, 20);
  assert.ok(hover && hover.contents && hover.contents.value.includes('lpf'));

  const comp = await client.completion('file:///live.strudel', 0, 16);
  assert.ok(comp.items.some((item) => item.label === 'sine'));

  await client.stop();
  assert.equal(client.state, LspState.STOPPED);
});
