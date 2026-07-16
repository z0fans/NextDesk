#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TARGET_HOST = 'github.com';
const DEFAULT_TARGET_PORT = 22;
const DEFAULT_EXPECT_PREFIX = 'SSH-';
const DEFAULT_READY_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = {
    targetHost: DEFAULT_TARGET_HOST,
    targetPort: DEFAULT_TARGET_PORT,
    expectPrefix: DEFAULT_EXPECT_PREFIX,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    configPath: process.env.NEXTDESK_CONFIG_PATH || '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      const candidate = argv[index + 1];
      if (!candidate) throw new Error(`missing value for ${value}`);
      index += 1;
      return candidate;
    };

    if (value === '--target-host') options.targetHost = next();
    else if (value === '--target-port') options.targetPort = Number(next());
    else if (value === '--expect-prefix') options.expectPrefix = next();
    else if (value === '--ready-timeout-ms') options.readyTimeoutMs = Number(next());
    else if (value === '--config') options.configPath = next();
    else if (value === '--no-prefix-check') options.expectPrefix = '';
    else if (value === '--help') options.help = true;
    else throw new Error(`unknown option: ${value}`);
  }

  if (!Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65535) {
    throw new Error('target port must be an integer from 1 to 65535');
  }
  if (!Number.isInteger(options.readyTimeoutMs) || options.readyTimeoutMs < 500) {
    throw new Error('ready timeout must be at least 500ms');
  }
  return options;
}

function defaultConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'NextDesk', 'config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'NextDesk', 'config.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'NextDesk', 'config.json');
}

function loadToken(configPath, deviceId) {
  if (process.env.NEXTDESK_CLOUD_TOKEN) return process.env.NEXTDESK_CLOUD_TOKEN.trim();

  if (process.platform === 'darwin') {
    try {
      return execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        'NextDesk Connect Gateway',
        '-a',
        deviceId,
        '-w',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Fall through to the file store used when Keychain access is unavailable.
    }
  }

  const tokenPath = path.join(path.dirname(configPath), `cloud_device_${deviceId}.token`);
  if (!existsSync(tokenPath)) throw new Error('cloud device token is not available on this device');
  return readFileSync(tokenPath, 'utf8').trim();
}

async function requestJson(baseUrl, pathname, token, deviceId, init = {}) {
  const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Device-Id': deviceId,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${pathname} returned non-JSON HTTP ${response.status}`);
    }
  }
  if (!response.ok) {
    const code = body?.error?.code || body?.code || `http_${response.status}`;
    throw new Error(`${pathname} rejected: ${code}`);
  }
  return body?.data ?? body;
}

function probeEndpoint(endpoint, expectPrefix, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    let received = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, total_ms: Date.now() - startedAt });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      if (!expectPrefix) finish({ ok: true, banner_prefix: null });
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const text = received.toString('utf8');
      if (text.startsWith(expectPrefix)) {
        finish({ ok: true, banner_prefix: text.slice(0, Math.min(text.length, 24)).trim() });
      } else if (received.length >= Math.max(expectPrefix.length, 24)) {
        finish({ ok: false, error: 'unexpected_banner' });
      }
    });
    socket.on('timeout', () => finish({ ok: false, error: 'probe_timeout' }));
    socket.on('end', () => finish({ ok: false, error: 'endpoint_closed' }));
    socket.on('error', () => finish({ ok: false, error: 'tcp_connect_failed' }));
  });
}

async function waitForEndpoint(endpoint, expectPrefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = { ok: false, error: 'not_started', total_ms: 0 };
  while (Date.now() < deadline) {
    const attemptTimeout = Math.min(3_000, Math.max(500, deadline - Date.now()));
    lastResult = await probeEndpoint(endpoint, expectPrefix, attemptTimeout);
    if (lastResult.ok) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`relay endpoint did not become usable: ${lastResult.error}`);
}

async function waitForForwardingReleased(endpoint, expectPrefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    const attemptTimeout = Math.min(2_000, Math.max(500, deadline - Date.now()));
    const probe = await probeEndpoint(endpoint, expectPrefix, attemptTimeout);
    if (!probe.ok) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) return;
    } else {
      consecutiveFailures = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('binding cleanup did not release the forwarding endpoint');
}

function printHelp() {
  console.log(`Usage: node scripts/cloud-relay-e2e.mjs [options]

Options:
  --target-host <host>       Forward target (default: ${DEFAULT_TARGET_HOST})
  --target-port <port>       Forward target port (default: ${DEFAULT_TARGET_PORT})
  --expect-prefix <text>     Expected first bytes (default: ${DEFAULT_EXPECT_PREFIX})
  --no-prefix-check          Only require a successful TCP connection
  --ready-timeout-ms <ms>    Endpoint readiness deadline (default: ${DEFAULT_READY_TIMEOUT_MS})
  --config <path>            Override NextDesk config.json path

The script never prints the device token or complete device/binding identifiers.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const configPath = options.configPath || defaultConfigPath();
  if (!existsSync(configPath)) throw new Error(`NextDesk config not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const baseUrl = String(config.dashboard_url || config.cloud_authorization_base_url || '').trim();
  const deviceId = String(config.cloud_device_id || '').trim();
  if (!baseUrl || !deviceId) throw new Error('NextDesk Cloud Mode is not authorized on this device');
  const token = loadToken(configPath, deviceId);
  if (!token) throw new Error('cloud device token is empty');

  const status = await requestJson(baseUrl, '/api/v1/connect/me', token, deviceId);
  if (!status?.account?.available) {
    throw new Error(`cloud account is unavailable: ${status?.account?.reason || 'unknown_reason'}`);
  }

  let binding = null;
  let result = null;
  let closeError = null;
  try {
    binding = await requestJson(baseUrl, '/api/v1/connect/bind', token, deviceId, {
      method: 'POST',
      body: JSON.stringify({
        target_host: options.targetHost,
        target_port: options.targetPort,
        preferred_region: 'auto',
        client: {
          platform: process.platform,
          app_version: 'cloud-relay-e2e',
        },
      }),
    });
    if (!binding?.binding_id || !binding?.endpoint?.host || !binding?.endpoint?.port) {
      throw new Error('bind response is missing the binding or endpoint');
    }

    const probe = await waitForEndpoint(
      binding.endpoint,
      options.expectPrefix,
      options.readyTimeoutMs,
    );
    result = {
      ok: true,
      platform: process.platform,
      authorized: true,
      account_available: true,
      binding_active: binding.status === 'active',
      endpoint_host: binding.endpoint.host,
      endpoint_port: binding.endpoint.port,
      protocols: binding.endpoint.protocols,
      data_plane_verified: probe.ok,
      banner_prefix: probe.banner_prefix,
      probe_ms: probe.total_ms,
    };
  } finally {
    if (binding?.binding_id) {
      await requestJson(baseUrl, '/api/v1/connect/close', token, deviceId, {
        method: 'POST',
        body: JSON.stringify({ binding_id: binding.binding_id }),
      }).catch((error) => {
        closeError = error;
      });
    }
  }

  if (closeError) throw new Error(`binding cleanup failed: ${closeError.message}`);
  if (!result) throw new Error('relay verification did not produce a result');
  await waitForForwardingReleased(binding.endpoint, options.expectPrefix, options.readyTimeoutMs);
  console.log(JSON.stringify({
    ...result,
    binding_closed: true,
    forwarding_released: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(`cloud relay e2e failed: ${error.message}`);
  process.exitCode = 1;
});
