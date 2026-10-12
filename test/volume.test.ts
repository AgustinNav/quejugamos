import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampVolume, initialAudioState, parseStoredVolume, steppedVolume, syncedFromElement, toggledMute,
  UNMUTE_VOLUME, withVolume,
} from '../public/js/volume.js';

describe('trailer volume rules', () => {
  test('first unmute on a fresh browser goes to 50%, never full volume', () => {
    const state = initialAudioState(null);
    assert.deepEqual(state, { muted: true, volume: 0.5 });
    assert.deepEqual(toggledMute(state), { muted: false, volume: UNMUTE_VOLUME });
  });

  test('unmute restores the level the user chose before', () => {
    assert.deepEqual(toggledMute(initialAudioState('0.3')), { muted: false, volume: 0.3 });
  });

  test('a stored level of 0 unmutes at 50%', () => {
    assert.deepEqual(toggledMute(initialAudioState('0')), { muted: false, volume: 0.5 });
  });

  test('volume up while muted unmutes at the remembered level', () => {
    assert.deepEqual(steppedVolume(initialAudioState(null), 1), { muted: false, volume: 0.5 });
    assert.deepEqual(steppedVolume(initialAudioState('0.8'), 1), { muted: false, volume: 0.8 });
  });

  test('volume down while muted stays muted', () => {
    const state = initialAudioState('0.4');
    assert.deepEqual(steppedVolume(state, -1), state);
  });

  test('reload starts muted and keeps the stored level', () => {
    const chosen = withVolume({ muted: false, volume: 0.5 }, 0.35);
    assert.deepEqual(initialAudioState(String(chosen.volume)), { muted: true, volume: 0.35 });
  });

  test('muting keeps the level for the next unmute', () => {
    assert.deepEqual(toggledMute({ muted: false, volume: 0.65 }), { muted: true, volume: 0.65 });
  });

  test('stepping clamps to [0, 1] and mutes at 0', () => {
    assert.deepEqual(steppedVolume({ muted: false, volume: 0.95 }, 1), { muted: false, volume: 1 });
    assert.deepEqual(steppedVolume({ muted: false, volume: 0.1 }, -1), { muted: true, volume: 0 });
    assert.deepEqual(steppedVolume({ muted: false, volume: 0.3 }, 1), { muted: false, volume: 0.4 }); // no 0.30000000000000004
  });

  test('slider at 0 mutes, anywhere else unmutes', () => {
    assert.deepEqual(withVolume({ muted: false, volume: 0.5 }, 0), { muted: true, volume: 0 });
    assert.deepEqual(withVolume({ muted: true, volume: 0.5 }, 0.2), { muted: false, volume: 0.2 });
  });

  test('junk in storage falls back to the default level', () => {
    for (const raw of ['', 'abc', 'NaN', 'Infinity', undefined]) assert.equal(parseStoredVolume(raw), null);
    assert.equal(initialAudioState('abc').volume, 0.5);
    assert.equal(parseStoredVolume('7'), 1);
    assert.equal(parseStoredVolume('-1'), 0);
    assert.equal(clampVolume(Number.NaN), 0);
  });

  test('native controls: unmuting at 0 gets the default; iOS keeps our level', () => {
    assert.deepEqual(syncedFromElement({ muted: true, volume: 0 }, { muted: false, volume: 0 }, true), { muted: false, volume: 0.5 });
    assert.deepEqual(syncedFromElement({ muted: true, volume: 0.3 }, { muted: false, volume: 1 }, false), { muted: false, volume: 0.3 });
    assert.deepEqual(syncedFromElement({ muted: false, volume: 0.3 }, { muted: false, volume: 0.9 }, true), { muted: false, volume: 0.9 });
  });
});
