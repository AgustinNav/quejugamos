import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AppConfig = {
  port: number;
  host: string;
  country: string;
  // How many proxies append to X-Forwarded-For in front of us (0 = ignore the header).
  trustedProxyHops: number;
  // Temporary diagnostics: logs X-Forwarded-For on room creation to calibrate trustedProxyHops.
  logProxyHeaders: boolean;
  publicDir: string;
  cacheFile: string | null;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseHops(env: NodeJS.ProcessEnv): number {
  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (env.TRUSTED_PROXY_HOPS !== undefined && Number.isInteger(hops) && hops >= 0 && hops <= 5) return hops;
  return env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' ? 1 : 0;
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 && value !== '' && value !== undefined ? port : 3000;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT),
    // Loopback by default: local use doesn't need LAN exposure. Deploys set HOST=0.0.0.0.
    host: env.HOST || '127.0.0.1',
    country: /^[a-z]{2}$/i.test(env.STEAM_CC ?? '') ? env.STEAM_CC!.toLowerCase() : 'ar',
    trustedProxyHops: parseHops(env),
    logProxyHeaders: env.LOG_PROXY_HEADERS === '1',
    publicDir: path.join(ROOT, 'public'),
    cacheFile: path.join(ROOT, '.steam-cache.json'),
  };
}
