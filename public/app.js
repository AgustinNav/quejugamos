import { GAMES, PLATFORMS } from './games.js';

const STORAGE_KEY = 'gamematch:v1';
const NO_PRICE_LIMIT = 70;
const SWIPE_THRESHOLD = 120;
const FETCH_CONCURRENCY = 6;

const $ = (id) => document.getElementById(id);
const gamesById = new Map(GAMES.map((g) => [g.id, g]));
const details = new Map();
let hls = null;
let muted = true;

const state = loadState();

// ---------- persistence ----------

function defaultState() {
  return {
    players: [],
    platforms: [...PLATFORMS],
    maxPrice: NO_PRICE_LIMIT,
    fitsGroup: true,
    deck: [],
    index: 0,
    votes: {},
    screen: 'setup',
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...defaultState(), ...saved } : defaultState();
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode); the session still works in memory.
  }
}

// ---------- helpers ----------

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function priceUsd(game) {
  const d = details.get(game.id);
  if (d?.isFree || game.priceLabel === 'Gratis') return 0;
  if (d?.price) return d.price.final / 100;
  return null;
}

function priceHtml(game) {
  const d = details.get(game.id);
  if (d?.isFree || game.priceLabel === 'Gratis') return { html: 'Gratis', free: true };
  if (d?.price) {
    const { initial, final, discount_percent: off, currency } = d.price;
    const fmt = (cents) => `${currency === 'USD' ? 'US$' : currency + ' '}${(cents / 100).toFixed(2)}`;
    if (off > 0) return { html: `<span class="old">${fmt(initial)}</span>${fmt(final)}<span class="off">-${off}%</span>` };
    return { html: fmt(final) };
  }
  return { html: esc(game.priceLabel || 'Ver precio') };
}

function storeLinks(game) {
  const q = encodeURIComponent(game.name);
  const links = [];
  if (game.steamId) links.push(['🛒 Steam', `https://store.steampowered.com/app/${game.steamId}`]);
  if (game.storeUrl) links.push(['🛒 Tienda oficial', game.storeUrl]);
  links.push(['▶ Gameplay en YouTube', `https://www.youtube.com/results?search_query=${q}+gameplay+coop`]);
  links.push(['💸 Comparar precios', `https://isthereanydeal.com/search/?q=${q}`]);
  return links;
}

function votesFor(gameId) {
  return state.votes[gameId] || {};
}

function tally(gameId) {
  const v = votesFor(gameId);
  const likers = state.players.filter((p) => v[p] === 'like');
  const nopes = state.players.filter((p) => v[p] === 'nope').length;
  return { likers, likes: likers.length, nopes };
}

// ---------- screens ----------

function showScreen(name) {
  state.screen = name;
  saveState();
  $('setupScreen').hidden = name !== 'setup';
  $('swipeScreen').hidden = name !== 'swipe';
  $('resultsScreen').hidden = name !== 'results';
  $('topbarActions').hidden = name === 'setup';
  if (name !== 'swipe') stopVideo();
  if (name === 'setup') renderSetup();
  if (name === 'swipe') renderCurrent();
  if (name === 'results') renderResults();
}

// ---------- setup ----------

function renderSetup() {
  $('playerChips').innerHTML = state.players
    .map((p, i) => `<li>${esc(p)} <button data-remove="${i}" title="Quitar">✕</button></li>`)
    .join('');
  $('platformToggles').innerHTML = PLATFORMS
    .map((p) => `<button class="toggle ${state.platforms.includes(p) ? 'on' : ''}" data-platform="${p}">${p}</button>`)
    .join('');
  $('maxPrice').value = state.maxPrice;
  $('maxPriceLabel').textContent = state.maxPrice >= NO_PRICE_LIMIT ? 'sin límite' : state.maxPrice === 0 ? 'solo gratis' : `US$ ${state.maxPrice}`;
  $('fitsGroup').checked = state.fitsGroup;
  $('setupHint').textContent = state.players.length ? '' : 'Agregá al menos un jugador para empezar.';
}

function bindSetup() {
  $('addPlayerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('playerInput').value.trim();
    if (name && !state.players.includes(name) && state.players.length < 9) state.players.push(name);
    $('playerInput').value = '';
    saveState();
    renderSetup();
  });
  $('playerChips').addEventListener('click', (e) => {
    const idx = e.target.dataset.remove;
    if (idx === undefined) return;
    state.players.splice(Number(idx), 1);
    saveState();
    renderSetup();
  });
  $('platformToggles').addEventListener('click', (e) => {
    const p = e.target.dataset.platform;
    if (!p) return;
    state.platforms = state.platforms.includes(p) ? state.platforms.filter((x) => x !== p) : [...state.platforms, p];
    saveState();
    renderSetup();
  });
  $('maxPrice').addEventListener('input', (e) => {
    state.maxPrice = Number(e.target.value);
    renderSetup();
  });
  $('fitsGroup').addEventListener('change', (e) => { state.fitsGroup = e.target.checked; });
  $('startBtn').addEventListener('click', startVoting);
}

function matchesFilters(game) {
  if (!game.platforms.some((p) => state.platforms.includes(p))) return false;
  if (state.fitsGroup && game.players[1] < state.players.length) return false;
  const price = priceUsd(game);
  if (state.maxPrice < NO_PRICE_LIMIT && price !== null && price > state.maxPrice) return false;
  return true;
}

async function startVoting() {
  if (!state.players.length) {
    $('setupHint').textContent = 'Agregá al menos un jugador para empezar.';
    return;
  }
  await loadAllDetails();
  const deck = shuffle(GAMES.filter(matchesFilters).map((g) => g.id));
  if (!deck.length) {
    $('setupHint').textContent = 'Ningún juego pasa esos filtros. Aflojá alguno.';
    return;
  }
  Object.assign(state, { deck, index: 0, votes: {} });
  showScreen('swipe');
}

// ---------- data ----------

async function fetchDetails(game) {
  if (!game.steamId || details.has(game.id)) return;
  try {
    const res = await fetch(`/api/steam/${game.steamId}`);
    if (res.ok) details.set(game.id, await res.json());
    else console.warn(`No Steam data for ${game.name}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`No Steam data for ${game.name}:`, err);
  }
}

async function loadAllDetails() {
  const pending = GAMES.filter((g) => g.steamId && !details.has(g.id));
  if (!pending.length) return;
  let done = 0;
  $('loading').hidden = false;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      await fetchDetails(queue.shift());
      $('loadingText').textContent = `Trayendo precios y trailers de Steam… ${++done}/${pending.length}`;
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  $('loading').hidden = true;
}

// ---------- swipe card ----------

function currentGame() {
  return gamesById.get(state.deck[state.index]);
}

function renderCurrent() {
  $('progress').textContent = `${Math.min(state.index + 1, state.deck.length)} / ${state.deck.length}`;
  const game = currentGame();
  if (!game) {
    showScreen('results');
    return;
  }
  resetCardPosition();
  renderMedia(game);
  renderInfo(game);
  renderVotes(game);
}

function renderInfo(game) {
  const d = details.get(game.id) || {};
  const price = priceHtml(game);
  $('gameName').textContent = game.name;
  $('gamePrice').innerHTML = price.html;
  $('gamePrice').className = `price ${price.free ? 'free' : ''}`;

  const [min, max] = game.players;
  const crossplay = game.crossplay === true ? ['good', '✓ Crossplay'] : game.crossplay === false ? ['bad', '✕ Sin crossplay'] : ['warn', '? Crossplay: verificar'];
  const meta = [
    `<span class="pill">👥 ${min === max ? min : `${min}–${max}`} jugadores</span>`,
    ...game.platforms.map((p) => `<span class="pill">${p}</span>`),
    `<span class="pill ${crossplay[0]}">${crossplay[1]}</span>`,
  ];
  if (d.reviews) meta.push(`<span class="pill">⭐ ${d.reviews.toLocaleString('es-AR')} reseñas</span>`);
  if (d.metacritic) meta.push(`<span class="pill">MC ${d.metacritic}</span>`);
  $('gameMeta').innerHTML = meta.join('');

  $('gameTags').innerHTML = game.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ');
  $('gamePitch').textContent = game.pitch;
  $('gameSteamDesc').textContent = d.shortDescription ? `Steam: “${d.shortDescription}”` : '';
  $('gameLinks').innerHTML = storeLinks(game)
    .map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .join('');
}

function renderVotes(game) {
  const v = votesFor(game.id);
  $('voteList').innerHTML = state.players
    .map((p, i) => `
      <li>
        <span class="key">${i + 1}</span>
        <span class="vote-name">${esc(p)}</span>
        <button class="vote-toggle like ${v[p] === 'like' ? 'on' : ''}" data-player="${i}" data-vote="like">👍</button>
        <button class="vote-toggle nope ${v[p] === 'nope' ? 'on' : ''}" data-player="${i}" data-vote="nope">👎</button>
      </li>`)
    .join('');
}

const NEXT_VOTE = { like: 'nope', nope: undefined };

function updateVote(playerIndex, nextValue) {
  const game = currentGame();
  const player = state.players[playerIndex];
  if (!game || !player) return;
  const gameVotes = (state.votes[game.id] ||= {});
  gameVotes[player] = nextValue(gameVotes[player]);
  saveState();
  renderVotes(game);
}

// Clicking the active button again clears the vote.
function setVote(playerIndex, vote) {
  updateVote(playerIndex, (current) => (current === vote ? undefined : vote));
}

// Number keys cycle: none -> like -> nope -> none.
function cycleVote(playerIndex) {
  updateVote(playerIndex, (current) => (current ? NEXT_VOTE[current] : 'like'));
}

function fillUnvoted(vote) {
  const game = currentGame();
  if (!game) return;
  const gameVotes = (state.votes[game.id] ||= {});
  state.players.forEach((p) => { if (!gameVotes[p]) gameVotes[p] = vote; });
  saveState();
}

function commitCard(forcedDirection) {
  const game = currentGame();
  if (!game) return;
  const { likes, nopes } = tally(game.id);
  const direction = forcedDirection || (likes > nopes ? 'right' : 'left');
  if (likes === state.players.length) showMatch(game);
  flyOut(direction, () => {
    state.index += 1;
    saveState();
    renderCurrent();
  });
}

function undo() {
  if (state.index === 0) return;
  state.index -= 1;
  delete state.votes[state.deck[state.index]];
  saveState();
  renderCurrent();
}

function showMatch(game) {
  const overlay = $('matchOverlay');
  $('matchGame').textContent = `${game.name} — les gusta a todos`;
  overlay.hidden = false;
  overlay.style.animation = 'none';
  void overlay.offsetWidth; // restart the CSS animation
  overlay.style.animation = '';
  setTimeout(() => { overlay.hidden = true; }, 1600);
}

// ---------- media ----------

function stopVideo() {
  if (hls) { hls.destroy(); hls = null; }
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function playTrailer(movie) {
  const video = $('video');
  stopVideo();
  video.hidden = false;
  $('mediaImg').hidden = true;
  video.poster = movie.poster || '';
  video.muted = muted;
  if (movie.mp4) {
    video.src = movie.mp4;
  } else if (window.Hls?.isSupported()) {
    hls = new window.Hls({ capLevelToPlayerSize: true });
    hls.loadSource(movie.hls);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = movie.hls;
  }
  video.play().catch(() => { /* autoplay may be blocked until the first click */ });
}

function showImage(url) {
  stopVideo();
  $('video').hidden = true;
  const img = $('mediaImg');
  img.hidden = false;
  img.src = url;
}

function renderMedia(game) {
  const d = details.get(game.id) || {};
  const media = document.querySelector('.media');
  media.querySelector('.placeholder')?.remove();
  const shots = [];
  if (d.movie) shots.push(`<button class="trailer-thumb active" data-trailer>▶ Trailer</button>`);
  (d.screenshots || []).forEach((s, i) => {
    shots.push(`<button data-shot="${esc(s)}" class="${!d.movie && i === 0 ? 'active' : ''}"><img src="${esc(s)}" alt="" loading="lazy"></button>`);
  });
  $('shots').innerHTML = shots.join('');
  $('muteBtn').hidden = !d.movie;

  if (d.movie) return playTrailer(d.movie);
  if (d.screenshots?.length || d.header) return showImage(d.screenshots?.[0] || d.header);
  stopVideo();
  $('video').hidden = true;
  $('mediaImg').hidden = true;
  media.insertAdjacentHTML('afterbegin', `<div class="placeholder">${esc(game.name)}</div>`);
}

function bindMedia() {
  $('shots').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('shots').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    const d = details.get(currentGame()?.id);
    if (btn.dataset.trailer !== undefined && d?.movie) playTrailer(d.movie);
    else if (btn.dataset.shot) showImage(btn.dataset.shot);
  });
  $('muteBtn').addEventListener('click', toggleMute);
}

function toggleMute() {
  muted = !muted;
  $('video').muted = muted;
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
}

// ---------- drag to swipe ----------

function setCardOffset(dx) {
  const card = $('card');
  card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  const strength = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
  card.querySelector('.stamp.like').style.opacity = dx > 0 ? strength : 0;
  card.querySelector('.stamp.nope').style.opacity = dx < 0 ? strength : 0;
}

function resetCardPosition() {
  const card = $('card');
  card.classList.remove('animating', 'dragging');
  card.style.opacity = 1;
  setCardOffset(0);
}

function flyOut(direction, done) {
  const card = $('card');
  const dx = (direction === 'right' ? 1 : -1) * window.innerWidth;
  card.classList.add('animating');
  setCardOffset(dx / 3);
  card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  card.style.opacity = 0;
  setTimeout(done, 380);
}

function bindDrag() {
  const card = $('card');
  let startX = null;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a') || card.classList.contains('animating')) return;
    startX = e.clientX;
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => {
    if (startX !== null) setCardOffset(e.clientX - startX);
  });
  const end = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    card.classList.remove('dragging');
    if (Math.abs(dx) < SWIPE_THRESHOLD) return resetCardPosition();
    // A drag is the host deciding for whoever hasn't voted yet.
    fillUnvoted(dx > 0 ? 'like' : 'nope');
    commitCard(dx > 0 ? 'right' : 'left');
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

// ---------- results ----------

function renderResults() {
  const seen = state.deck.slice(0, state.index).map((id) => gamesById.get(id)).filter(Boolean);
  const rows = seen
    .map((game) => ({ game, ...tally(game.id) }))
    .sort((a, b) => b.likes - a.likes || a.nopes - b.nopes || (priceUsd(a.game) ?? 99) - (priceUsd(b.game) ?? 99));

  if (!rows.length) {
    $('ranking').innerHTML = '<p class="empty">Todavía no votaron ningún juego.</p>';
    return;
  }
  const total = state.players.length;
  $('ranking').innerHTML = rows.map((row, i) => resultRow(row, i, total)).join('');
  // Widths set via CSSOM: the CSP blocks inline style attributes.
  $('ranking').querySelectorAll('[data-pct]').forEach((bar) => { bar.style.width = `${bar.dataset.pct}%`; });
}

function resultRow({ game, likers, likes, nopes }, i, total) {
  const d = details.get(game.id) || {};
  const isMatch = likes === total;
  const thumb = d.header ? `<img src="${esc(d.header)}" alt="">` : `<div class="thumb-ph">${esc(game.name)}</div>`;
  const link = game.steamId ? `https://store.steampowered.com/app/${game.steamId}` : game.storeUrl;
  return `
    <li class="${isMatch ? 'match' : ''}">
      <span class="rank">${isMatch ? '💘' : i + 1}</span>
      ${thumb}
      <div>
        <p class="r-name">${esc(game.name)}</p>
        <p class="r-sub">${likes}/${total} likes · ${nopes} nope${likers.length ? ` · <span class="likers">${likers.map(esc).join(', ')}</span>` : ''}</p>
        <div class="bar"><span data-pct="${Math.round((likes / total) * 100)}"></span></div>
      </div>
      <div class="r-right">
        <span class="price ${priceHtml(game).free ? 'free' : ''}">${priceHtml(game).html}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver tienda ↗</a>` : ''}
      </div>
    </li>`;
}

// ---------- wiring ----------

function bindSwipeControls() {
  $('voteList').addEventListener('click', (e) => {
    const btn = e.target.closest('.vote-toggle');
    if (btn) setVote(Number(btn.dataset.player), btn.dataset.vote);
  });
  $('nextBtn').addEventListener('click', () => commitCard());
  $('allLikeBtn').addEventListener('click', () => { fillUnvoted('like'); renderVotes(currentGame()); });
  $('allNopeBtn').addEventListener('click', () => { fillUnvoted('nope'); renderVotes(currentGame()); });
  $('undoBtn').addEventListener('click', undo);
  $('resultsBtn').addEventListener('click', () => showScreen('results'));
  $('setupBtn').addEventListener('click', () => showScreen('setup'));
  $('backToSwipeBtn').addEventListener('click', () => showScreen('swipe'));
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('¿Borrar todos los votos y barajar de nuevo?')) return;
    startVoting();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'swipe' || e.target instanceof HTMLInputElement) return;
    if (/^[1-9]$/.test(e.key)) return cycleVote(Number(e.key) - 1);
    const actions = {
      ArrowRight: () => commitCard(),
      Enter: () => commitCard(),
      ArrowLeft: undo,
      Backspace: undo,
      m: toggleMute,
      M: toggleMute,
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  });
}

async function init() {
  bindSetup();
  bindSwipeControls();
  bindMedia();
  bindDrag();
  bindKeyboard();
  if (state.screen !== 'setup' && state.deck.length) {
    await loadAllDetails();
    showScreen(state.screen);
  } else {
    showScreen('setup');
  }
}

init();
