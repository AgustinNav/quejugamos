// Loads a Steam trailer into a <video>: mp4 when Steam has one, else HLS via the vendored
// hls.js (or Safari's native HLS). Shared by the card and the gallery.

// Returns a handle whose destroy() stops the download and frees the decoder.
export function attachMovie(video, movie) {
  let hls = null;
  video.poster = movie.poster || '';
  if (movie.mp4) {
    video.src = movie.mp4;
  } else if (movie.hls && window.Hls?.isSupported()) {
    hls = new window.Hls({ capLevelToPlayerSize: true });
    hls.loadSource(movie.hls);
    hls.attachMedia(video);
  } else if (movie.hls && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = movie.hls;
  }
  return {
    destroy() {
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
