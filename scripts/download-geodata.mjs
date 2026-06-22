import { copyFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const binDir = path.join(rootDir, '.backend', 'bin');
const baseUrl = 'https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download';
const downloadTimeoutMs = Number(process.env.NEXTDESK_GEODATA_DOWNLOAD_TIMEOUT_MS ?? 120000);

const files = [
  ['Country.mmdb', 'country-lite.mmdb'],
  ['geoip.metadb', 'geoip-lite.metadb'],
  ['geosite.dat', 'geosite.dat'],
];

async function replaceFile(tmpFile, outputPath) {
  try {
    await rename(tmpFile, outputPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
    await copyFile(tmpFile, outputPath);
    await unlink(tmpFile);
  }
}

async function download(label, sourceName, outputPath, tmpDir) {
  const url = `${baseUrl}/${sourceName}`;
  const tmpFile = path.join(tmpDir, label);

  console.log(`Refreshing ${label}...`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await rm(tmpFile, { force: true });
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(tmpFile, bytes);
      await replaceFile(tmpFile, outputPath);
      console.log(`  -> Saved to ${outputPath}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  throw lastError;
}

await mkdir(binDir, { recursive: true });
const tmpDir = await mkdtemp(path.join(binDir, '.nextdesk-geodata-'));

try {
  for (const [label, sourceName] of files) {
    await download(label, sourceName, path.join(binDir, label), tmpDir);
  }
  console.log('Geodata refreshed successfully.');
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
