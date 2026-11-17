import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * Supervisor for local use: starts the three services and the console as
 * separate OS processes against a fresh data directory, then tears them all
 * down on Ctrl-C.
 */
const root = resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR || resolve(root, 'data');

if (process.argv.includes('--fresh')) {
  rmSync(dataDir, { recursive: true, force: true });
}

const children = [];
const services = [
  ['exchange', 'src/services/exchange/server.js'],
  ['validation', 'src/services/validation/app.js'],
  ['ingestion', 'src/services/ingestion/app.js'],
  ['console', 'src/console/app.js'],
];

for (const [name, file] of services) {
  const child = fork(resolve(root, file), [], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.log(`[supervisor] ${name} exited code=${code} signal=${signal}`);
    if (code !== 0 && !shuttingDown) shutdown(code ?? 1);
  });
  children.push({ name, child });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

setTimeout(() => {
  console.log(`[supervisor] console on http://127.0.0.1:${process.env.CONSOLE_PORT || 4180}/`);
  console.log(`[supervisor] data directory ${dataDir}`);
}, 800);
