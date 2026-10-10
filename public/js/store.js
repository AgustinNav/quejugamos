// Per-room credentials in localStorage. Storage can throw (private mode, blocked cookies):
// the app keeps working, the session just won't survive a reload.

const PREFIX = 'gamematch:room:';

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
