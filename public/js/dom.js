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

export function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

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
