import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createApp } from './app.js';
import { createSettings } from './settings.js';
import { loadAdminKey } from './admin-key.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readConfig(env) {
  const port = Number(env.PORT ?? 8080);
  const maxUploadMb = Number(env.MAX_UPLOAD_MB ?? 4096);
  const workspaceLimitMb = Number(env.MAX_WORKSPACE_MB ?? 10240);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) throw new Error('MAX_UPLOAD_MB must be > 0');
  if (!Number.isInteger(workspaceLimitMb) || workspaceLimitMb < 0) {
    throw new Error('MAX_WORKSPACE_MB must be a whole number ≥ 0 (0 = unlimited)');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? path.join(projectRoot, 'data')),
    maxUploadBytes: Math.floor(maxUploadMb * 1024 * 1024),
    defaultWorkspaceLimitMb: workspaceLimitMb === 0 ? null : workspaceLimitMb,
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : null,
  };
}

// Typical home/office LANs first; VPN, CGNAT and container ranges last.
function addressRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .sort((a, b) => addressRank(a) - addressRank(b));
}

async function main() {
  const config = readConfig(process.env);
  await fs.mkdir(config.dataDir, { recursive: true });
  const { key, source } = await loadAdminKey(config.dataDir, process.env.ADMIN_KEY);
  const store = createStore(config.dataDir);
  await store.init();

  const settings = await createSettings(config.dataDir);

  const handler = createApp({
    store,
    settings,
    adminKey: key,
    publicDir: path.join(projectRoot, 'public'),
    maxUploadBytes: config.maxUploadBytes,
    defaultWorkspaceLimitMb: config.defaultWorkspaceLimitMb,
    publicUrl: config.publicUrl,
    lanUrls: lanAddresses().map((a) => `http://${a}:${config.port}`),
  });
  const server = http.createServer(handler);
  server.requestTimeout = 0; // large uploads can take a while

  server.listen(config.port, config.host, () => {
    const urls = [`http://localhost:${config.port}`, ...lanAddresses().map((a) => `http://${a}:${config.port}`)];
    const lines = [
      '',
      '  Lockerdrop is running',
      '',
      ...urls.map((u) => `  Receiver  ${u}/`),
      ...urls.map((u) => `  Admin     ${u}/admin   (local network only)`),
      ...(config.publicUrl ? [`  Tunnel    ${config.publicUrl}/`] : []),
      '',
      source === 'env'
        ? '  Admin key: from ADMIN_KEY'
        : `  Admin key: ${key}${source === 'generated' ? '  (new, saved to data/admin.key)' : ''}`,
      `  Data dir:  ${config.dataDir}`,
      '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Failed to start: ${err.message}\n`);
  process.exit(1);
});
