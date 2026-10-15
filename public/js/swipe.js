// The open card: drag-to-vote with LIKE/NOPE stamps, throw/spring-back, the close animations and
// the swap onto the card underneath (stack.js). The math lives in gesture.js (DOM-free, tested).
//
// The card element is never replaced. Its states:
//   rest     -> dragging (finger down, horizontal) -> spring back | thrown out
//   thrown out (`out` is set) -> returnCard() if the vote did not close it, or the room's close
//   animation, which swaps the next game in while the card is hidden (prepareNextCard/revealNextCard).
import { $ } from './dom.js';
import {
  dragFrame, flyOutTarget, lockAxis, releaseDecision, swipeThreshold, velocityX, VELOCITY_WINDOW_MS,
} from './gesture.js';
import { freezeUnder, unfreezeUnder } from './stack.js';

const PLAYED_OUT_MS = 700;
const REJECTED_OUT_MS = 850; // .card.rejected-out: .3s shake + .55s drop
const SPRING_MS = 320;
const RETURN_MS = 300;
const FADE_MS = 200; // upper bound of .card.fading (styles.css): .16s, or .2s with reduced motion
const CLICK_SUPPRESS_MS = 350;
const EASE_OUT = 'cubic-bezier(.22,.61,.36,1)';
const SPRING = 'cubic-bezier(.175,.885,.32,1.275)';
// Never start a drag on something the user means to tap, type into or scrub.
const NO_DRAG = 'a, button, input, select, textarea, label, video, [contenteditable], .media-actions';

const REST = { x: 0, y: 0, rotation: 0 };

let offset = REST;
let out = null; // promise of the throw while the card is off screen (or fading out)
let drag = null;
let rafId = 0;
let generation = 0; // bumps on every animation so a stale cleanup never undoes a newer one
let suppressClicksUntil = 0;

const card = () => $('card');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- painting ----------

function applyOffset(next) {
  offset = { x: next.x, y: next.y, rotation: next.rotation };
  card().style.transform = next === REST ? '' : `translate3d(${next.x}px, ${next.y}px, 0) rotate(${next.rotation}deg)`;
}

// null clears the inline opacity so the voted-like / voted-nope classes show the own vote.
function setStamps(like, nope) {
  const el = card();
  el.querySelector('.stamp.like').style.opacity = like === null ? '' : String(like);
  el.querySelector('.stamp.nope').style.opacity = nope === null ? '' : String(nope);
}

function setUnderScale(scale, ms = 0, easing = EASE_OUT) {
  const under = $('cardUnder');
  under.style.transition = ms ? `transform ${ms}ms ${easing}` : 'none';
  under.style.transform = scale === null ? '' : `scale(${scale})`;
}

// Resolves on the element's own transitionend for `property`, or after a timeout: transitionend
// never fires if the value did not change, the tab is hidden or another transition replaced it.
function afterTransition(el, property, ms) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (e) => { if (e.target === el && e.propertyName === property) finish(); };
    const timer = setTimeout(finish, ms + 80);
    el.addEventListener('transitionend', onEnd);
  });
}

// Transitions the card to `target`; cleanup (will-change off) only if nothing newer started.
async function moveCard(target, ms, easing) {
  const el = card();
  const gen = ++generation;
  el.classList.add('moving');
  el.style.transition = `transform ${ms}ms ${easing}`;
  applyOffset(target);
  await afterTransition(el, 'transform', ms);
  if (gen !== generation) return;
  el.style.transition = '';
  el.classList.remove('moving');
}

async function fadeCard(opacity) {
  const el = card();
  ++generation;
  el.classList.add('fading');
  el.style.opacity = opacity;
  await afterTransition(el, 'opacity', FADE_MS);
}

// ---------- public animations ----------

export const isCardOut = () => out !== null;

export function showVoteStamp(vote) {
  const el = card();
  el.classList.toggle('voted-like', vote === 'like');
  el.classList.toggle('voted-nope', vote === 'nope');
}

/** Instant reset, no animation (leaving the room, or a state the animations did not expect). */
export function resetCard() {
  const el = card();
  ++generation;
  abortDrag();
  out = null;
  el.classList.remove('moving', 'fading', 'played-out', 'rejected-out');
  el.style.transition = '';
  el.style.opacity = '';
  applyOffset(REST);
  setStamps(null, null);
  setUnderScale(null);
  unfreezeUnder();
}

// The room closed the card while a finger was still on it: the close animation wins.
function abortDrag() {
  drag = null;
  cancelAnimationFrame(rafId);
  rafId = 0;
  card().classList.remove('dragging');
}

// Throws the card off screen from wherever it is, keeping the release velocity (px/ms).
function throwCard(direction, { vx = 0, width = card().offsetWidth } = {}) {
  abortDrag();
  setStamps(direction === 'right' ? 1 : 0, direction === 'right' ? 0 : 1);
  if (reducedMotion()) {
    setUnderScale(1);
    out = fadeCard('0');
    return out;
  }
  const target = flyOutTarget({ from: offset, direction, viewportWidth: window.innerWidth, cardWidth: width, vx });
  setUnderScale(1, target.durationMs);
  out = moveCard(target, target.durationMs, EASE_OUT);
  return out;
}

/** Card closed by the room: fly towards the result, unless the own swipe already threw it. */
export function flyOut(direction) {
  return out ?? throwCard(direction);
}

/** Most voters had played it: the card shrinks and fades in place with its own stamp, never as LIKE/NOPE. */
export function playedOut() {
  if (out) return out;
  const el = card();
  ++generation;
  abortDrag();
  setStamps(0, 0);
  el.style.transition = ''; // .card.played-out owns the timing
  el.classList.add('played-out');
  el.style.transform = 'scale(.85)';
  el.style.opacity = '0';
  setUnderScale(1, PLAYED_OUT_MS);
  out = afterTransition(el, 'transform', PLAYED_OUT_MS);
  return out;
}

/** Everyone who voted said nope: the card shakes, then drops with a NOPE stamp (styles.css owns the timing). */
export function rejectedOut() {
  if (out) return out;
  abortDrag();
  setStamps(0, 1);
  if (reducedMotion()) {
    setUnderScale(1);
    out = fadeCard('0');
    return out;
  }
  const el = card();
  ++generation;
  el.style.transition = '';
  el.classList.add('rejected-out');
  el.style.transform = 'translateY(70vh) rotate(-6deg) scale(.9)';
  el.style.opacity = '0';
  setUnderScale(1, REJECTED_OUT_MS);
  out = afterTransition(el, 'transform', REJECTED_OUT_MS);
  return out;
}

/** Neutral quick exit for the optimistic advance when the own vote was "played" (the result decides later). */
export function fadeAway() {
  if (out) return out;
  abortDrag();
  setStamps(0, 0);
  setUnderScale(1, FADE_MS);
  out = fadeCard('0');
  return out;
}

/** Brings a thrown card back (its vote failed, or did not close the card after all). */
export function returnCard() {
  if (!out) return;
  out = null;
  const el = card();
  el.classList.remove('fading');
  el.style.opacity = '';
  setStamps(null, null);
  setUnderScale(null, RETURN_MS);
  moveCard(REST, RETURN_MS, EASE_OUT);
}

function springBack() {
  setStamps(null, null);
  setUnderScale(null, SPRING_MS, SPRING);
  moveCard(REST, SPRING_MS, SPRING);
}

/**
 * Step 1 of the swap, once the card is off screen: park it hidden at rest so the next game can be
 * painted into it. The card underneath already shows that game and stays put (frozen) meanwhile.
 */
export function prepareNextCard() {
  const el = card();
  ++generation;
  freezeUnder();
  el.classList.remove('moving', 'played-out', 'rejected-out', 'fading', 'dragging');
  el.style.transition = 'none';
  el.style.opacity = '0';
  applyOffset(REST);
  setStamps(null, null);
}

/**
 * Step 2: fade the card in over the identical-looking card underneath, then drop the underneath
 * back to the next-next game. Never waits for media: the cover is already cached by the preview
 * underneath and the trailer starts whenever it is ready.
 */
export async function revealNextCard() {
  const el = card();
  void el.offsetWidth; // commit the hidden state so the fade has a "from" without waiting for frames
  el.style.transition = '';
  el.classList.add('fading');
  el.style.opacity = '';
  await afterTransition(el, 'opacity', FADE_MS);
  el.classList.remove('fading');
  out = null;
  setUnderScale(null);
  unfreezeUnder();
}

// ---------- gesture ----------

function onPointerDown(e, canSwipe) {
  if (!e.isPrimary) return; // a second finger never starts or breaks a swipe
  // A new primary pointer means the previous gesture ended without a pointerup reaching us
  // (mouse released outside the card before the axis lock): drop it instead of locking forever.
  if (drag) onPointerCancel({ pointerId: drag.id });
  if (out || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.target.closest(NO_DRAG) || document.body.classList.contains('gallery-open') || !canSwipe()) return;
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, axis: null, width: 0, samples: [] };
  addSample(e);
}

function addSample(e) {
  drag.samples.push({ t: e.timeStamp, x: e.clientX });
  while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > VELOCITY_WINDOW_MS * 2) drag.samples.shift();
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dx = e.clientX - drag.x0;
  drag.dy = e.clientY - drag.y0;
  if (!drag.axis) lockDrag();
  if (drag?.axis !== 'x') return;
  addSample(e);
  if (!rafId) rafId = requestAnimationFrame(paintDrag);
}

// Vertical first: hand the gesture to the page scroll. Horizontal: own it until release.
function lockDrag() {
  const axis = lockAxis(drag.dx, drag.dy);
  if (axis === 'y') drag = null;
  if (axis !== 'x') return;
  const el = card();
  drag.axis = 'x';
  drag.width = el.offsetWidth; // the only layout read of the gesture
  ++generation; // a spring-back still running gets caught mid-way, not finished later
  el.style.transition = 'none';
  el.classList.add('dragging', 'moving');
  try {
    el.setPointerCapture(drag.id);
  } catch (err) {
    console.warn('[swipe] pointer capture failed:', err);
  }
}

function paintDrag() {
  rafId = 0;
  if (drag?.axis !== 'x') return;
  const frame = dragFrame(drag.dx, drag.dy, drag.width);
  applyOffset(frame);
  setStamps(frame.likeOpacity, frame.nopeOpacity);
  setUnderScale(frame.underScale);
}

function onPointerUp(e, onSwipe) {
  if (!drag || e.pointerId !== drag.id) return;
  const gesture = drag;
  drag = null;
  if (gesture.axis !== 'x') return; // a tap: let the click through
  suppressClicksUntil = performance.now() + CLICK_SUPPRESS_MS;
  gesture.dx = e.clientX - gesture.x0;
  gesture.dy = e.clientY - gesture.y0;
  const vx = velocityX([...gesture.samples, { t: e.timeStamp, x: e.clientX }]);
  release(gesture, vx, onSwipe);
}

function release(gesture, vx, onSwipe) {
  abortDrag();
  applyOffset(dragFrame(gesture.dx, gesture.dy, gesture.width)); // start exactly where the finger left it
  const vote = releaseDecision({ dx: gesture.dx, vx, threshold: swipeThreshold(gesture.width) });
  // onSwipe casts the vote and says whether it closes the card ('leave') or not ('stay').
  if (vote && onSwipe(vote) === 'leave') throwCard(vote === 'like' ? 'right' : 'left', { vx, width: gesture.width });
  else springBack();
}

function onPointerCancel(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const wasDragging = drag.axis === 'x';
  abortDrag();
  if (wasDragging) springBack();
}

/**
 * onSwipe(vote) receives 'like' | 'nope' and returns 'leave' when that vote closes the card (it is
 * thrown out) or 'stay' (it springs back showing the vote). canSwipe() can lock the card.
 */
export function bindSwipe({ onSwipe, canSwipe }) {
  const el = card();
  el.addEventListener('pointerdown', (e) => onPointerDown(e, canSwipe));
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', (e) => onPointerUp(e, onSwipe));
  el.addEventListener('pointercancel', onPointerCancel);
  // iOS Safari can still start a scroll or rubber-band mid-swipe; once the swipe owns the
  // gesture, block the touch default. Not passive, or preventDefault is ignored.
  el.addEventListener('touchmove', (e) => { if (drag?.axis === 'x') e.preventDefault(); }, { passive: false });
  el.addEventListener('dragstart', (e) => e.preventDefault()); // image/link drag ghost on desktop
  el.addEventListener('click', (e) => {
    if (performance.now() > suppressClicksUntil) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
