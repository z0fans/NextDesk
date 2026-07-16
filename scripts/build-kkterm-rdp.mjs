import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const cargoToml = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoConfig = readFileSync(cargoToml, 'utf8');

if (
  !cargoConfig.includes('kkterm-rdp = ["ironrdp/cliprdr"]') ||
  !cargoConfig.includes("cfg(nextdesk_kkterm_rdp)")
) {
  console.error('src-tauri/Cargo.toml is not using the KKTerm IronRDP dependency graph');
  process.exit(1);
}

const existingRustflags = process.env.RUSTFLAGS ?? '';
const rustflags = existingRustflags.includes('nextdesk_kkterm_rdp')
  ? existingRustflags
  : `${existingRustflags} --cfg nextdesk_kkterm_rdp`.trim();

const env = {
  ...process.env,
  VITE_NEXTDESK_RDP_ENGINE: process.env.VITE_NEXTDESK_RDP_ENGINE ?? 'kkterm-copy',
  VITE_NEXTDESK_KKTERM_KEYBOARD_MODE:
    process.env.VITE_NEXTDESK_KKTERM_KEYBOARD_MODE ?? 'remote-scancode',
  RUSTFLAGS: rustflags,
};

const passthroughArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg.endsWith('.json') && !passthroughArgs.includes('--config')) {
    passthroughArgs.push('--config', arg);
  } else {
    passthroughArgs.push(arg);
  }
}

const args = ['tauri', 'build', '--features', 'kkterm-rdp', ...passthroughArgs];
const child = spawn('npx', args, {
  cwd: rootDir,
  env,
  shell: true,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`npx tauri build terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
