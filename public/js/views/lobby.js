// Lobby: host sees QR + filters + "Empezar"; players see who is in and wait.
import { $, showScreen, renderNameList, toast } from '../dom.js';
import { PLATFORMS } from '../catalog.js';
import { qrDataUrl } from '../qr.js';
import { roomUrl } from '../code.js';
import { errorMessage } from '../errors.js';

const NO_PRICE_LIMIT = 70;
const MAX_PLAYERS = 12;
// playerCount null = automatic: games where everyone in the room fits. 5 stands for "5+".
const PLAYER_COUNT_OPTIONS = [null, 2, 3, 4, 5];
const filters = { platforms: [...PLATFORMS], maxPrice: NO_PRICE_LIMIT, playerCount: null };
let roomPlayers = 1;
let qrCode = null;

export function currentFilters() {
  return {
    platforms: [...filters.platforms],
    maxPrice: filters.maxPrice >= NO_PRICE_LIMIT ? null : filters.maxPrice,
    playerCount: filters.playerCount,
  };
}

export function renderHostLobby(room) {
  const { players } = room.state;
  roomPlayers = players.length;
  renderInvite(room.code);
  renderNameList('lobbyPlayers', players, room.session.playerId, { kickable: true });
  $('lobbyCount').textContent = `(${players.length}/${MAX_PLAYERS})`;
  renderFilters();
  showScreen('lobbyHostScreen');
}

export function renderPlayerLobby(room) {
  const { players } = room.state;
  const host = players.find((p) => p.isHost);
  $('lobbyWaiting').textContent = `Esperando a que ${host ? host.name : 'el host'} arranque la votación…`;
  renderNameList('lobbyPlayersPhone', players, room.session.playerId);
  $('lobbyPlayerCount').textContent = `(${players.length}/${MAX_PLAYERS})`;
  showScreen('lobbyPlayerScreen');
}

export function setStartError(code) {
  $('startError').textContent = code ? errorMessage(code) : '';
}

function renderInvite(code) {
  if (qrCode === code) return;
  qrCode = code;
  const url = roomUrl(code);
  const src = qrDataUrl(url);
  $('qrImg').hidden = !src;
  if (src) $('qrImg').src = src;
  $('inviteUrl').textContent = url.replace(/^https?:\/\//, '');
  $('inviteCode').textContent = code;
}

function renderFilters() {
  $('platformToggles').innerHTML = PLATFORMS
    .map((p) => `<button type="button" class="toggle ${filters.platforms.includes(p) ? 'on' : ''}" data-platform="${p}" aria-pressed="${filters.platforms.includes(p)}">${p}</button>`)
    .join('');
  $('maxPrice').value = filters.maxPrice;
  $('maxPriceLabel').textContent = priceLabel(filters.maxPrice);
  renderPlayerCount();
}

function playerCountLabel(value) {
  if (value === null) return `Automático (${roomPlayers} en la sala)`;
  return value === 5 ? '5+' : String(value);
}

function renderPlayerCount() {
  $('playerCountToggles').innerHTML = PLAYER_COUNT_OPTIONS
    .map((n) => {
      const on = filters.playerCount === n;
      return `<button type="button" class="toggle ${on ? 'on' : ''}" data-player-count="${n ?? 'auto'}" aria-pressed="${on}">${playerCountLabel(n)}</button>`;
    })
    .join('');
}

function priceLabel(value) {
  if (value >= NO_PRICE_LIMIT) return 'sin límite';
  return value === 0 ? 'solo gratis' : `US$ ${value}`;
}

function togglePlatform(platform) {
  const on = filters.platforms.includes(platform);
  filters.platforms = on ? filters.platforms.filter((p) => p !== platform) : [...filters.platforms, platform];
  renderFilters();
  $('platformToggles').querySelector(`[data-platform="${platform}"]`)?.focus();
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(roomUrl(qrCode));
    toast('Link copiado 📋');
  } catch (err) {
    console.warn('[lobby] clipboard unavailable:', err);
    toast('No pude copiar: copiá el link de la pantalla.');
  }
}

export function bindLobby(onStart) {
  $('platformToggles').addEventListener('click', (e) => {
    const platform = e.target.closest('[data-platform]')?.dataset.platform;
    if (platform) togglePlatform(platform);
  });
  $('maxPrice').addEventListener('input', (e) => {
    filters.maxPrice = Number(e.target.value);
    $('maxPriceLabel').textContent = priceLabel(filters.maxPrice);
  });
  $('playerCountToggles').addEventListener('click', (e) => {
    const value = e.target.closest('[data-player-count]')?.dataset.playerCount;
    if (!value) return;
    filters.playerCount = value === 'auto' ? null : Number(value);
    renderPlayerCount();
    $('playerCountToggles').querySelector(`[data-player-count="${value}"]`)?.focus();
  });
  $('copyLinkBtn').addEventListener('click', copyLink);
  $('startBtn').addEventListener('click', async () => {
    if (!filters.platforms.length) return setStartError('invalid_filters');
    setStartError(null);
    $('startBtn').disabled = true;
    try {
      await onStart(currentFilters());
    } finally {
      $('startBtn').disabled = false;
    }
  });
}
