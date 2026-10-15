// Technical SEO: index.html placeholders resolved per deploy, robots.txt and sitemap.xml.
// The public origin comes from PUBLIC_ORIGIN (validated in config.ts), never from the Host header:
// a spoofed Host must not change canonical or OG URLs.
import fs from 'node:fs/promises';

export type SeoConfig = {
  publicOrigin: string;
  googleSiteVerification: string | null;
  bingSiteVerification: string | null;
};

const ORIGIN_PLACEHOLDER = /__PUBLIC_ORIGIN__/g;
const VERIFICATION_PLACEHOLDER = '<!--__SITE_VERIFICATION__-->';

export function escapeHtmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function verificationTags(seo: SeoConfig): string {
  const tags: string[] = [];
  if (seo.googleSiteVerification) {
    tags.push(`<meta name="google-site-verification" content="${escapeHtmlAttr(seo.googleSiteVerification)}">`);
  }
  if (seo.bingSiteVerification) tags.push(`<meta name="msvalidate.01" content="${escapeHtmlAttr(seo.bingSiteVerification)}">`);
  return tags.join('\n  ');
}

export function renderIndex(template: string, seo: SeoConfig): string {
  return template
    .replace(ORIGIN_PLACEHOLDER, escapeHtmlAttr(seo.publicOrigin))
    .replace(VERIFICATION_PLACEHOLDER, verificationTags(seo));
}

export function robotsTxt(publicOrigin: string): string {
  // Room pages and the API stay crawlable on purpose: they answer X-Robots-Tag: noindex, which a
  // crawler only sees if robots.txt lets it fetch them.
  return `User-agent: *\nAllow: /\n\nSitemap: ${publicOrigin}/sitemap.xml\n`;
}

export function sitemapXml(publicOrigin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeHtmlAttr(publicOrigin)}/</loc></url>`,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Renders index.html once per file version. Re-reading on mtime change keeps `npm start` edits live
 * without re-rendering on every request.
 */
export function createIndexRenderer(filePath: string, seo: SeoConfig): () => Promise<string> {
  let cached: { mtimeMs: number; html: string } | null = null;
  return async () => {
    const { mtimeMs } = await fs.stat(filePath);
    if (cached?.mtimeMs === mtimeMs) return cached.html;
    const html = renderIndex(await fs.readFile(filePath, 'utf8'), seo);
    cached = { mtimeMs, html };
    return html;
  };
}
