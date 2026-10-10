// Entry point: tiny router for "/" (landing) and "/r/:code" (room).
import { bindLanding, showLanding } from './js/views/landing.js';
import { bindJoin } from './js/views/join.js';
import { bindLobby } from './js/views/lobby.js';
import { bindError, showError } from './js/views/error.js';
import { bindMedia } from './js/media.js';
import { bindActions, startVoting } from './js/actions.js';
import { enterRoom } from './js/room.js';
import { normalizeCode } from './js/code.js';

let leaveCurrent = null;

function route() {
  leaveCurrent?.();
  leaveCurrent = null;
  document.body.classList.remove('is-host', 'is-phone');
  const match = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!match) return showLanding();
  const code = normalizeCode(match[1]);
  if (!code) return showError('invalid_code');
  if (code !== match[1]) history.replaceState(null, '', `/r/${code}`);
  leaveCurrent = enterRoom(code);
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

function init() {
  bindLanding(navigate);
  bindJoin();
  bindLobby(startVoting);
  bindError();
  bindMedia();
  bindActions();
  window.addEventListener('popstate', route);
  route();
}

init();
