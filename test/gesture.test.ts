import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_LOCK_PX, FLICK_MIN_DX, FLICK_VELOCITY, UNDER_SCALE_REST,
  closesCard, dragFrame, flyOutTarget, lockAxis, releaseDecision, swipeThreshold, velocityX,
} from '../public/js/gesture.js';

describe('lockAxis', () => {
  test('stays undecided inside the slop (a tap)', () => {
    assert.equal(lockAxis(0, 0), null);
    assert.equal(lockAxis(5, 5), null); // ~7 px
  });

  test('locks to the dominant axis once past the slop', () => {
    assert.equal(lockAxis(AXIS_LOCK_PX, 0), 'x');
    assert.equal(lockAxis(-9, 3), 'x');
    assert.equal(lockAxis(3, 9), 'y');
    assert.equal(lockAxis(2, -12), 'y');
  });

  test('a perfect diagonal goes to the page scroll', () => {
    assert.equal(lockAxis(10, 10), 'y');
  });
});

describe('swipeThreshold', () => {
  test('is ~30 % of the card, clamped for tiny and huge cards', () => {
    assert.equal(swipeThreshold(350), 105);
    assert.equal(swipeThreshold(100), 80);
    assert.equal(swipeThreshold(1200), 120);
  });
});

describe('dragFrame', () => {
  test('at rest nothing shows', () => {
    const f = dragFrame(0, 0, 350);
    assert.equal(f.x, 0);
    assert.equal(f.rotation, 0);
    assert.equal(f.likeOpacity, 0);
    assert.equal(f.nopeOpacity, 0);
    assert.equal(f.underScale, UNDER_SCALE_REST);
  });

  test('right drag: LIKE grows with distance, NOPE stays hidden, rotation follows', () => {
    const half = dragFrame(52.5, 0, 350);
    assert.equal(half.likeOpacity, 0.5);
    assert.equal(half.nopeOpacity, 0);
    assert.ok(half.rotation > 0);
    const full = dragFrame(400, 0, 350);
    assert.equal(full.likeOpacity, 1);
    assert.equal(full.underScale, 1);
  });

  test('left drag mirrors it', () => {
    const f = dragFrame(-105, 0, 350);
    assert.equal(f.nopeOpacity, 1);
    assert.equal(f.likeOpacity, 0);
    assert.ok(f.rotation < 0);
  });

  test('rotation is capped and vertical movement is damped', () => {
    const f = dragFrame(5000, 100, 350);
    assert.equal(f.rotation, 18);
    assert.ok(f.y > 0 && f.y < 100);
  });
});

describe('velocityX', () => {
  test('needs at least two samples', () => {
    assert.equal(velocityX([]), 0);
    assert.equal(velocityX([{ t: 0, x: 10 }]), 0);
  });

  test('uses only the last 100 ms', () => {
    const samples = [
      { t: 0, x: 0 }, // slow start, ignored
      { t: 400, x: 10 },
      { t: 450, x: 40 },
      { t: 500, x: 110 },
    ];
    assert.equal(velocityX(samples), 1); // (110 - 10) / 100
  });

  test('a finger that stopped before lifting has no velocity', () => {
    assert.equal(velocityX([{ t: 0, x: 0 }, { t: 300, x: 200 }, { t: 450, x: 200 }, { t: 500, x: 200 }]), 0);
  });
});

describe('releaseDecision', () => {
  const threshold = 105;

  test('springs back below the threshold without a flick', () => {
    assert.equal(releaseDecision({ dx: 100, vx: 0.1, threshold }), null);
    assert.equal(releaseDecision({ dx: -50, vx: 0, threshold }), null);
  });

  test('votes past the threshold', () => {
    assert.equal(releaseDecision({ dx: threshold, vx: 0, threshold }), 'like');
    assert.equal(releaseDecision({ dx: -200, vx: -0.2, threshold }), 'nope');
  });

  test('a fast flick votes below the threshold', () => {
    assert.equal(releaseDecision({ dx: 40, vx: FLICK_VELOCITY, threshold }), 'like');
    assert.equal(releaseDecision({ dx: -30, vx: -1.2, threshold }), 'nope');
  });

  test('a flick needs a minimum travel', () => {
    assert.equal(releaseDecision({ dx: FLICK_MIN_DX - 1, vx: 2, threshold }), null);
  });

  test('flicking back towards the centre cancels even past the threshold', () => {
    assert.equal(releaseDecision({ dx: 150, vx: -0.8, threshold }), null);
    assert.equal(releaseDecision({ dx: -150, vx: 0.8, threshold }), null);
  });
});

describe('flyOutTarget', () => {
  test('ends fully off screen on the chosen side, keeping the vertical offset', () => {
    const right = flyOutTarget({ from: { x: 120, y: 10, rotation: 6 }, direction: 'right', viewportWidth: 390, cardWidth: 366 });
    assert.ok(right.x >= 390 + 366);
    assert.equal(right.y, 10);
    assert.ok(right.rotation > 0);
    const left = flyOutTarget({ from: { x: 0, y: 0, rotation: 0 }, direction: 'left', viewportWidth: 390, cardWidth: 366 });
    assert.ok(left.x <= -(390 + 366));
    assert.ok(left.rotation < 0);
  });

  test('duration stays in the 220-340 ms band and shrinks with a faster release', () => {
    const base = { from: { x: 100, y: 0, rotation: 0 }, direction: 'right', viewportWidth: 390, cardWidth: 366 };
    const slow = flyOutTarget({ ...base, vx: 0 });
    const fast = flyOutTarget({ ...base, vx: 3 });
    for (const t of [slow, fast]) assert.ok(t.durationMs >= 220 && t.durationMs <= 340, String(t.durationMs));
    assert.ok(fast.durationMs < slow.durationMs);
  });
});

describe('closesCard', () => {
  const players = [{ id: 'host' }, { id: 'me' }, { id: 'ana' }];

  test('true when every other player already voted and I did not', () => {
    assert.equal(closesCard({ players, currentVoters: ['host', 'ana'] }, 'me'), true);
  });

  test('false while someone else is still pending', () => {
    assert.equal(closesCard({ players, currentVoters: ['host'] }, 'me'), false);
  });

  test('false when I am only changing my vote', () => {
    assert.equal(closesCard({ players, currentVoters: ['me', 'host'] }, 'me'), false);
  });

  test('players who voted "played" count: currentVoters says who voted, not what', () => {
    assert.equal(closesCard({ players, currentVoters: ['host', 'ana'] }, 'me'), true);
  });

  test('a solo voter always closes the card', () => {
    assert.equal(closesCard({ players: [{ id: 'me' }], currentVoters: [] }, 'me'), true);
  });
});
