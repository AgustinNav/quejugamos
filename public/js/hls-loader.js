// hls.js is ~129 KB brotli and only trailers without an mp4 need it, so it is fetched on first use
// instead of in <head>. The element is created from script-src 'self' (no inline script).
const HLS_SRC = '/vendor/hls.min.js';
const HLS_INTEGRITY = 'sha384-w6Gb3fXHb5e1LUYa/hYA5Q41bEDglN5ZPCG7Jvnoo8/X90oGnlPqBlBJCe38mEMm';

let pending = null;

/** Resolves with the Hls constructor, or null when it cannot load. Never rejects; loads at most once. */
export function loadHls(win = window, doc = document) {
  if (win.Hls) return Promise.resolve(win.Hls);
  if (!pending) {
    pending = new Promise((resolve) => {
      try {
        const script = doc.createElement('script');
        script.src = HLS_SRC;
        script.integrity = HLS_INTEGRITY;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.onload = () => resolve(win.Hls ?? null);
        script.onerror = () => resolve(null);
        doc.head.appendChild(script);
      } catch {
        resolve(null);
      }
    });
  }
  return pending;
}

/** Test hook: forget the cached load so a failure can be retried or re-simulated. */
export function resetHlsLoader() {
  pending = null;
}

/** Same MSE probe hls.js' isSupported() runs, without needing the library loaded. */
export function hlsLikelySupported(win = window) {
  const MS = win.ManagedMediaSource || win.MediaSource || win.WebKitMediaSource;
  if (!MS) return false;
  try {
    return typeof MS.isTypeSupported === 'function' && MS.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
  } catch {
    return false;
  }
}
