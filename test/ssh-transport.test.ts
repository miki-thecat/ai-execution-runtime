import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:net';
import { SshControlClient, createSemanticOperationEnvelope } from '../src/remote/index.ts';
import { LocalDaemonClient } from '../src/server/daemon.ts';

function fixture(t, mode = 'success') {
  let server;
  let endpoint;
  let argv;
  let spawnOptions;
  const sockets = new Set();
  let startup = Promise.resolve();
  let cleanup;
  const close = () => cleanup ??= (async () => {
    await startup;
    if (!server?.listening) return;
    const socketsClosed = [...sockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve);
      socket.destroy();
    }));
    await Promise.all([
      new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }),
      ...socketsClosed,
    ]);
    assert.equal(server.listening, false);
    assert.equal(sockets.size, 0);
  })();
  t.after(close);
  const received = [];
  const signals = [];
  const child = new EventEmitter();
  child.kill = signal => {
    signals.push(signal);
    void close().then(() => child.emit('close', 0, signal), error => child.emit('error', error));
    return true;
  };
  const spawnProcess = (command, args, options) => {
    assert.equal(command, 'ssh');
    argv = args;
    spawnOptions = options;
    endpoint = args[args.indexOf('-L') + 1].split(':')[0];
    if (mode === 'startup-timeout') return child;
    server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', data => {
        buffer += data;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        received.push(request);
        if (mode === 'success') socket.end(`${JSON.stringify({ type: 'response', value: { echoed: request } })}\n`);
        if (mode === 'disconnect') socket.destroy();
        socket.removeAllListeners('data');
      });
    });
    startup = new Promise(resolve => {
      server.once('error', error => { child.emit('error', error); resolve(); });
      server.listen(endpoint, resolve);
    });
    return child;
  };
  return { spawnProcess, received, signals, get endpoint() { return endpoint; }, get argv() { return argv; }, get spawnOptions() { return spawnOptions; } };
}
const options = { host: 'user@fixture', remoteSocket: '/run/aer/control.sock', expectedDeviceId: 'device_remote', cleanupTimeoutMs: 20 };
const envelope = () => createSemanticOperationEnvelope({ operation: 'fixture.read', target: { deviceId: 'device_remote', projectId: 'project_fixture' }, deviceId: 'device_remote', input: { text: 'unchanged' }, deadline: Date.now() + 10_000, budgets: { maxOutputBytes: 1234 }, idempotencyKey: 'same-key' });

test('SSH uses safe argv and private unique sockets; preserves the full envelope', async t => {
  const fake = fixture(t);
  const other = fixture(t);
  const client = await SshControlClient.connect({ ...options, spawnProcess: fake.spawnProcess });
  const second = await SshControlClient.connect({ ...options, spawnProcess: other.spawnProcess });
  try {
    assert.notEqual(client.endpoint, second.endpoint);
    assert.equal(statSync(dirname(client.endpoint)).mode & 0o777, 0o700);
    assert.deepEqual(fake.spawnOptions, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    for (const arg of ['-N', '-T', '-a', '-x', 'BatchMode=yes', 'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ControlPath=none']) assert.ok(fake.argv.includes(arg));
    assert.equal(fake.argv.at(-1), options.host);
    assert.equal(fake.argv[fake.argv.indexOf('-L') + 1], `${client.endpoint}:${options.remoteSocket}`);
    const request = { type: 'execute', envelope: envelope() };
    assert.deepEqual(await client.request(request), { echoed: request });
    assert.deepEqual(fake.received, [request]);
  } finally { await client.close(); await second.close(); }
  assert.equal(existsSync(dirname(client.endpoint)), false);
  assert.deepEqual(fake.signals, ['SIGTERM']);
  await client.close();
  assert.deepEqual(fake.signals, ['SIGTERM']);
});

test('SSH rejects absent, foreign, and conflicting device bindings without forwarding', async t => {
  const fake = fixture(t);
  const client = await SshControlClient.connect({ ...options, spawnProcess: fake.spawnProcess });
  try {
    for (const binding of [{ target: undefined, deviceId: undefined }, { deviceId: 'foreign' }, { target: { deviceId: 'foreign' } }]) {
      await assert.rejects(client.request({ type: 'execute', envelope: { ...envelope(), ...binding } }), { code: 'DEVICE_TRANSPORT_UNBOUND' });
    }
    assert.deepEqual(fake.received, []);
  } finally { await client.close(); }
});

for (const mode of ['disconnect', 'timeout']) test(`SSH ${mode} after receipt retains daemon UNKNOWN semantics without replay`, async t => {
  const fake = fixture(t, mode);
  const client = await SshControlClient.connect({ ...options, timeoutMs: 40, spawnProcess: fake.spawnProcess });
  try {
    const daemon = new LocalDaemonClient({ endpoint: client.endpoint, transport: client });
    const result = await daemon.execute(envelope());
    assert.equal(result.error.code, 'DAEMON_RESPONSE_UNKNOWN');
    assert.equal(result.meta.status, 'unknown');
    assert.equal(fake.received.length, 1);
  } finally { await client.close(); }
});

test('SSH startup timeout cleans its private directory and process', async t => {
  const fake = fixture(t, 'startup-timeout');
  await assert.rejects(SshControlClient.connect({ ...options, startupTimeoutMs: 20, spawnProcess: fake.spawnProcess }), { code: 'SSH_STARTUP_FAILED' });
  assert.equal(existsSync(dirname(fake.endpoint)), false);
  assert.deepEqual(fake.signals, ['SIGTERM']);
});

test('SSH rejects option injection and ambiguous forwarding syntax before spawning', async () => {
  for (const override of [{ host: '-oProxyCommand=bad' }, { remoteSocket: '/tmp/a:b' }]) {
    await assert.rejects(SshControlClient.connect({ ...options, ...override, spawnProcess: () => { assert.fail('must not spawn'); } }), TypeError);
  }
});
