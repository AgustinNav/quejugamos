// Per-room credentials in localStorage. Storage can throw (private mode, blocked cookies):
// the app keeps working, the session just won't survive a reload.

const PREFIX = 'quejugamos:room:';
// Old versions remembered "already played" games across rooms; that memory is gone for good.
const LEGACY_PLAYED_KEY = 'quejugamos:played';

/** Best-effort removal of the retired cross-room "played" list from this device. */
export function dropLegacyPlayedList() {
  try {
    localStorage.removeItem(LEGACY_PLAYED_KEY);
  } catch (err) {
    console.warn('[store] could not clear legacy played list:', err);
  }
}

export function loadSession(code) {
  try {
    const session = JSON.parse(localStorage.getItem(PREFIX + code));
    return isValidSession(session) ? session : null;
  } catch (err) {
    console.warn('[store] could not read session:', err);
    return null;
  }
}

export function saveSession(code, session) {
  try {
    localStorage.setItem(PREFIX + code, JSON.stringify(session));
  } catch (err) {
    console.warn('[store] could not save session:', err);
  }
}

export function clearSession(code) {
  try {
    localStorage.removeItem(PREFIX + code);
  } catch (err) {
    console.warn('[store] could not clear session:', err);
  }
}

function isValidSession(session) {
  return Boolean(session && typeof session.playerToken === 'string' && typeof session.playerId === 'string');
}
