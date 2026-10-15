// Tiny DOM helpers. The CSP forbids inline styles/handlers, so everything goes through
// classes, element.style (CSSOM) and addEventListener.

export const $ = (id) => document.getElementById(id);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SCREENS = ['landingScreen', 'joinScreen', 'lobbyHostScreen', 'lobbyPlayerScreen', 'votingScreen', 'resultsScreen', 'errorScreen'];

export function showScreen(id) {
  SCREENS.forEach((screen) => { $(screen).hidden = screen !== id; });
  $('loading').hidden = true;
}

export function setLoading(visible, text = 'Cargando…') {
  $('loadingText').textContent = text;
  $('loading').hidden = !visible;
}

let toastTimer = null;
let toastUntil = 0;

// One toast at a time: a new one replaces the text and restarts the lifetime.
export function toast(message, { ms = 3500 } = {}) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastUntil = Date.now() + ms;
  toastTimer = setTimeout(clearToast, ms);
}

export function clearToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  toastUntil = 0;
  $('toast').hidden = true;
}

// Hidden tabs throttle timers (up to a minute in Chrome): a toast whose lifetime ran out while the
// user was in another tab must not greet them, over a different card, when they come back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && toastTimer && Date.now() >= toastUntil) clearToast();
});

// Screen-reader announcement; clearing first makes repeated messages re-announce.
// setTimeout (not rAF) so it still lands when the tab is in the background.
export function announce(message) {
  const el = $('announcer');
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

// Builds an <li> list with textContent only, so user names can never inject markup.
// kickable: the host's view adds a "✕" (handled by delegation on the list, see actions.js).
export function renderNameList(listId, players, myId, { kickable = false } = {}) {
  const list = $(listId);
  list.replaceChildren(...players.map((player) => nameChip(player, myId, kickable)));
}

function nameChip(player, myId, kickable) {
  const li = document.createElement('li');
  li.textContent = player.name;
  if (player.isHost) li.append(badge('host'));
  if (player.id === myId) li.append(badge('vos'));
  if (kickable && !player.isHost) li.append(kickButton(player));
  return li;
}

export function kickButton(player) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kick-btn';
  button.dataset.kick = player.id;
  button.textContent = '✕';
  button.setAttribute('aria-label', `Sacar a ${player.name} de la sala`);
  button.title = `Sacar a ${player.name}`;
  return button;
}

function badge(text) {
  const span = document.createElement('span');
  span.className = 'chip-badge';
  span.textContent = text;
  return span;
}
