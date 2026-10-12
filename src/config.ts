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
  // Absolute origin (no path) used in canonical/OG URLs, robots.txt and sitemap.xml.
  publicOrigin: string;
  googleSiteVerification: string | null;
  bingSiteVerification: string | null;
  // Invalid env values that were ignored; logged as WARNING when the app starts.
  warnings: string[];
};

export const DEFAULT_PUBLIC_ORIGIN = 'https://quejugamos.onrender.com';
// Restricting the origin to these characters makes it safe to inline in HTML attributes and JSON-LD.
const SAFE_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{10,100}$/;

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

/** Accepts only an http(s) origin without path, query or credentials; anything else → default + warning. */
function parsePublicOrigin(value: string | undefined, warnings: string[]): string {
  if (value === undefined || value === '') return DEFAULT_PUBLIC_ORIGIN;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    warnings.push(`PUBLIC_ORIGIN is not a valid URL, using ${DEFAULT_PUBLIC_ORIGIN}`);
    return DEFAULT_PUBLIC_ORIGIN;
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (bare && SAFE_ORIGIN.test(url.origin)) return url.origin;
  warnings.push(`PUBLIC_ORIGIN must be an http(s) origin without path, using ${DEFAULT_PUBLIC_ORIGIN}`);
  return DEFAULT_PUBLIC_ORIGIN;
}

function parseVerification(name: string, value: string | undefined, warnings: string[]): string | null {
  if (value === undefined || value === '') return null;
  if (VERIFICATION_TOKEN.test(value)) return value;
  warnings.push(`${name} ignored: expected 10-100 characters [A-Za-z0-9_-]`);
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const warnings: string[] = [];
  return {
    port: parsePort(env.PORT),
    // Loopback by default: local use doesn't need LAN exposure. Deploys set HOST=0.0.0.0.
    host: env.HOST || '127.0.0.1',
    country: /^[a-z]{2}$/i.test(env.STEAM_CC ?? '') ? env.STEAM_CC!.toLowerCase() : 'ar',
    trustedProxyHops: parseHops(env),
    logProxyHeaders: env.LOG_PROXY_HEADERS === '1',
    publicDir: path.join(ROOT, 'public'),
    cacheFile: path.join(ROOT, '.steam-cache.json'),
    publicOrigin: parsePublicOrigin(env.PUBLIC_ORIGIN, warnings),
    googleSiteVerification: parseVerification('GOOGLE_SITE_VERIFICATION', env.GOOGLE_SITE_VERIFICATION, warnings),
    bingSiteVerification: parseVerification('BING_SITE_VERIFICATION', env.BING_SITE_VERIFICATION, warnings),
    warnings,
  };
}
