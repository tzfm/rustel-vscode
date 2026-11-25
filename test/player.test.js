'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PlayState, RustelPlayer } = require('../src/player');

test('RustelPlayer spawns rustel play --watch --ui-events, streams events, and sends stop control', async () => {
  const spawned = [];
  const receivedEvents = [];
  const receivedErrors = [];
  const stdinLines = [];

  const spawnFn = (cmd, args) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };
    child.stdin.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) stdinLines.push(text);
      if (text.includes('"action":"stop"')) {
        process.nextTick(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        });
      }
    });

    process.nextTick(() => {
      child.stdout.write(
        JSON.stringify({
          ui_events: {
            version: 2,
            device_time: 0.1,
            source_revision: 'abc',
            events: [{ context: [[2, 4]], target_time: 0.12, duration_secs: 0.2 }],
          },
        }) + '\n'
      );
      child.stderr.write(
        JSON.stringify({ reload: { status: 'rejected', message: 'syntax error' } }) + '\n'
      );
    });

    return child;
  };

  const player = new RustelPlayer({
    serverPath: 'rustel',
    spawnFn,
    onEvents: (batch) => receivedEvents.push(batch),
    onPlaybackError: (msg) => receivedErrors.push(msg),
  });

  const first = await player.playFile('/tmp/song.strudel', { extraArgs: ['--output', 'silent'] });
  assert.deepEqual(first, { started: true, reloaded: false });
  assert.equal(player.state, PlayState.PLAYING);
  assert.deepEqual(spawned[0].args, [
    'play',
    '/tmp/song.strudel',
    '--watch',
    '--ui-events',
    '--output',
    'silent',
  ]);

  // Calling playFile again on the same file lets --watch handle the reload.
  const second = await player.playFile('/tmp/song.strudel');
  assert.deepEqual(second, { started: false, reloaded: true });
  assert.equal(spawned.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(receivedEvents.length, 1);
  assert.deepEqual(receivedErrors, ['syntax error']);

  await player.stop();
  assert.equal(player.state, PlayState.STOPPED);
  assert.ok(stdinLines.some((line) => line.includes('"kind":"transport"') && line.includes('"action":"stop"')));
});

test('RustelPlayer cleans up temporary selection files on stop', async () => {
  let tempPath = null;
  const spawnFn = (_cmd, args) => {
    tempPath = args[1];
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    };
    child.stdin.on('data', () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  };

  const player = new RustelPlayer({ spawnFn });
  await player.playSnippet('note("c4 e4 g4").s("sine")');
  assert.ok(tempPath && fs.existsSync(tempPath));

  await player.stop();
  assert.equal(fs.existsSync(tempPath), false);
});
