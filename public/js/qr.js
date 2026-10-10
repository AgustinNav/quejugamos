// QR rendering with the vendored qrcode-generator (public/vendor/qrcode.js, global `qrcode`).
// Output is an SVG data URL: allowed by the CSP (img-src data:) and crisp at any size.

export function qrDataUrl(text) {
  if (typeof window.qrcode !== 'function') {
    console.warn('[qr] qrcode-generator not loaded');
    return null;
  }
  const qr = window.qrcode(0, 'M'); // 0 = smallest version that fits
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
