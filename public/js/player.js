// Loads a Steam trailer into a <video>: mp4 when Steam has one, else HLS via the vendored
// hls.js (or Safari's native HLS). Shared by the card and the gallery.
import { prepareVideo } from './audio.js';
import { loadHls } from './hls-loader.js';

// Returns a handle whose destroy() stops the download and frees the decoder.
export function attachMovie(video, movie) {
  let hls = null;
  let destroyed = false;
  prepareVideo(video); // before any source: crossOrigin only applies to loads that start after it
  video.poster = movie.poster || '';
  if (movie.mp4) {
    video.src = movie.mp4;
  } else if (movie.hls) {
    // hls.js loads on first need; if it can't (offline, blocked), Safari's native HLS still works.
    loadHls().then((Hls) => {
      if (destroyed) return;
      if (Hls?.isSupported()) {
        hls = new Hls({ capLevelToPlayerSize: true });
        hls.loadSource(movie.hls);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = movie.hls;
      }
    });
  }
  return {
    destroy() {
      destroyed = true;
      if (hls) { hls.destroy(); hls = null; }
      unloadVideo(video);
    },
  };
}

// Pausing alone keeps buffering (and on some browsers, audio): dropping the source is what stops it.
export function unloadVideo(video) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export function playQuietly(video) {
  video.play().catch(() => { /* autoplay can be blocked until the first user gesture */ });
}
