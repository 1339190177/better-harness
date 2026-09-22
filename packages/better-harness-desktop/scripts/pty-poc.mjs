#!/usr/bin/env node
// PTY driver proof-of-concept harness.
//
// Runs one command two ways — through the native `harness-pty-host` (a real
// controlling terminal) and through plain pipes (`stdio: ["pipe","pipe","pipe"]`,
// what every current native path uses) — and prints the difference plus a
// structured JSONL step trace of the terminal session. It touches no product
// code; it exists only to show what a TTY buys and what a terminal session can
// hand an offline judge.
//
// Usage:
//   node scripts/pty-poc.mjs [--build] [--trace <file>] -- <command> [args...]
//
// With no command it runs a small probe that reports whether stdout is a tty
// and how many colors the terminal advertises.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { build: false, trace: undefined, command: undefined, args: [] };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === '--') {
      options.command = rest.shift();
      options.args = rest.splice(0);
      break;
    }
    if (token === '--build') options.build = true;
    else if (token === '--trace') options.trace = rest.shift();
    else throw new Error(`unknown option: ${token}`);
  }
  if (!options.command) {
    // A probe that behaves visibly differently under a tty vs a pipe.
    options.command = '/bin/sh';
    options.args = [
      '-c',
      'if [ -t 1 ]; then echo "stdout: TTY"; else echo "stdout: PIPE"; fi; ' +
        'printf "colors: "; tput colors 2>/dev/null || echo "n/a"; ' +
        'printf "size: "; stty size 2>/dev/null || echo "n/a"',
    ];
  }
  return options;
}

/** Locate the built driver, building it on request. */
function resolveDriver(build) {
  const candidates = [
    process.env.HARNESS_PTY_HOST,
    join(root, 'dist', 'rust', 'release', 'harness-pty-host'),
    join(root, 'rust', 'pty-service', 'target', 'release', 'harness-pty-host'),
  ].filter(Boolean);
  if (build || !candidates.some((path) => existsSync(path))) {
    console.error('[pty-poc] building harness-pty-host (release)…');
    const result = spawnSync(
      'cargo',
      ['+1.96.0', 'build', '--release', '--manifest-path',
        join(root, 'rust', 'pty-service', 'Cargo.toml')],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error('cargo build failed');
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('harness-pty-host not found; pass --build');
  return found;
}

/** A minimal duplex JSONL client over the pty host's stdio. */
class PtyClient {
  constructor(executable) {
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    this.child.stdout.on('data', (chunk) => this.ingest(chunk));
  }

  ingest(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() === '') continue;
      const frame = JSON.parse(line);
      if (frame.event) this.onEvent(frame.event);
      else if (this.pending.has(frame.id)) {
        const { resolve: settle } = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        settle(frame);
      }
    }
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    const frame = `${JSON.stringify({ version: 1, id, method, params })}\n`;
    return new Promise((settle) => {
      this.pending.set(id, { resolve: settle });
      this.child.stdin.write(frame);
    });
  }

  close() {
    this.child.stdin.end();
  }
}

/** Run the command through a real PTY, returning output bytes and a step trace. */
async function runThroughPty(executable, command, args) {
  const client = new PtyClient(executable);
  const start = process.hrtime.bigint();
  const trace = [];
  const chunks = [];
  const stamp = () => Number((process.hrtime.bigint() - start) / 1000n) / 1000; // ms

  const done = new Promise((settleDone) => {
    client.onEvent = (event) => {
      if (event.type === 'pty.data') {
        const bytes = Buffer.from(event.dataBase64, 'base64');
        chunks.push(bytes);
        trace.push({ t: stamp(), dir: 'out', type: 'data', bytes: bytes.length });
      } else if (event.type === 'pty.exit') {
        trace.push({ t: stamp(), dir: 'out', type: 'exit', code: event.code, signal: event.signal });
        settleDone(event);
      }
    };
  });

  const describe = await client.call('host.describe');
  trace.push({ t: stamp(), dir: 'in', type: 'describe', protocol: describe.result.protocol });

  const spawned = await client.call('pty.spawn', { command, args, rows: 24, cols: 80 });
  const ptyId = spawned.result.ptyId;
  trace.push({ t: stamp(), dir: 'in', type: 'spawn', command, args, ptyId });

  const exit = await done;
  client.close();
  return { output: Buffer.concat(chunks), trace, exit };
}

/** Run the same command with plain pipes — no controlling terminal. */
function runThroughPipe(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    output: Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]),
    code: result.status,
    signal: result.signal,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const executable = resolveDriver(options.build);
  console.error(`[pty-poc] driver: ${executable}`);
  console.error(`[pty-poc] command: ${options.command} ${options.args.join(' ')}`);

  const pty = await runThroughPty(executable, options.command, options.args);
  const pipe = runThroughPipe(options.command, options.args);

  const traceFile = options.trace
    ?? join(await mkdtemp(join(tmpdir(), 'pty-poc-')), 'trace.jsonl');
  await writeFile(traceFile, pty.trace.map((step) => JSON.stringify(step)).join('\n') + '\n');

  const line = '─'.repeat(60);
  console.log(`\n${line}\nWITH TTY (harness-pty-host)\n${line}`);
  process.stdout.write(pty.output);
  console.log(`\n[exit] code=${pty.exit.code} signal=${pty.exit.signal} bytes=${pty.output.length} steps=${pty.trace.length}`);

  console.log(`\n${line}\nWITHOUT TTY (stdio pipes)\n${line}`);
  process.stdout.write(pipe.output);
  console.log(`\n[exit] code=${pipe.code} signal=${pipe.signal} bytes=${pipe.output.length}`);

  console.log(`\n${line}\nDIFFERENCE\n${line}`);
  const same = pty.output.equals(pipe.output);
  console.log(`output identical: ${same}`);
  if (!same) {
    console.log(`  tty  bytes: ${pty.output.length}`);
    console.log(`  pipe bytes: ${pipe.output.length}`);
  }
  console.log(`structured trace: ${traceFile} (${pty.trace.length} steps)`);
}

main().catch((error) => {
  console.error(`[pty-poc] ${error.stack ?? error}`);
  process.exit(1);
});
