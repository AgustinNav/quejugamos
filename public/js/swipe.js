// Drag-to-vote on the card, LIKE/NOPE stamps and the fly-out animation when a card closes.
import { $ } from './dom.js';

const SWIPE_THRESHOLD = 110;
const FLY_OUT_MS = 380;
const PLAYED_OUT_MS = 700;

function stamps() {
  const card = $('card');
  return { like: card.querySelector('.stamp.like'), nope: card.querySelector('.stamp.nope') };
}

// Inline opacity only while dragging; empty string lets the "voted-*" classes show the stamp.
function setCardOffset(dx) {
  const card = $('card');
  card.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 25}deg)` : '';
  const strength = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
  const { like, nope } = stamps();
  like.style.opacity = dx > 0 ? String(strength) : '';
  nope.style.opacity = dx < 0 ? String(strength) : '';
}

export function resetCard() {
  const card = $('card');
  card.classList.remove('animating', 'dragging', 'played-out');
  card.style.opacity = '';
  setCardOffset(0);
}

export function showVoteStamp(vote) {
  const card = $('card');
  card.classList.toggle('voted-like', vote === 'like');
  card.classList.toggle('voted-nope', vote === 'nope');
}

export function flyOut(direction) {
  const card = $('card');
  const dx = (direction === 'right' ? 1 : -1) * window.innerWidth;
  card.classList.add('animating');
  const { like, nope } = stamps();
  like.style.opacity = direction === 'right' ? '1' : '0';
  nope.style.opacity = direction === 'right' ? '0' : '1';
  card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
  card.style.opacity = '0';
  return new Promise((resolve) => setTimeout(resolve, FLY_OUT_MS));
}

// "Ya lo jugamos": the card shrinks and fades in place with its own stamp, never as LIKE/NOPE.
export function playedOut() {
  const card = $('card');
  const { like, nope } = stamps();
  like.style.opacity = '0';
  nope.style.opacity = '0';
  card.classList.add('played-out');
  card.style.transform = 'scale(.85)';
  card.style.opacity = '0';
  return new Promise((resolve) => setTimeout(resolve, PLAYED_OUT_MS));
}

// onSwipe receives 'like' | 'nope'; canSwipe lets the caller lock the card (e.g. mid-animation).
export function bindSwipe(onSwipe, canSwipe) {
  const card = $('card');
  let startX = null;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a') || !canSwipe()) return;
    startX = e.clientX;
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => {
    if (startX !== null) setCardOffset(e.clientX - startX);
  });
  const end = (e) => {
    if (startX === null) return;
    const dx = e.type === 'pointercancel' ? 0 : e.clientX - startX;
    startX = null;
    resetCard();
    if (Math.abs(dx) >= SWIPE_THRESHOLD) onSwipe(dx > 0 ? 'like' : 'nope');
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}
