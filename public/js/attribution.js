// Acquisition signals for POST /api/rooms (docs/API.md): where the visit came from (?ref=) and whether
// this browser joined someone else's room before (guest → host loop). Storage can throw (private
// mode, blocked cookies): attribution is best effort and never blocks the app.

const REF_KEY = 'quejugamos:ref';
const GUEST_KEY = 'quejugamos:wasGuest';
const REF_MAX = 32;

/** Stores ?ref= for this tab and strips it from the URL so shared links don't carry it along. */
export function captureRef() {
  const params = new URLSearchParams(location.search);
  if (!params.has('ref')) return;
  const ref = params.get('ref').trim().toLowerCase().slice(0, REF_MAX);
  if (ref) {
    try {
      sessionStorage.setItem(REF_KEY, ref);
    } catch (err) {
      console.warn('[attribution] could not save ref:', err);
    }
  }
  params.delete('ref');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

export function markGuest() {
  try {
    localStorage.setItem(GUEST_KEY, '1');
  } catch (err) {
    console.warn('[attribution] could not save guest flag:', err);
  }
}

/** Extra fields for POST /api/rooms. The server maps ref to a closed list, so sending it raw is fine. */
export function attributionFields() {
  const fields = {};
  try {
    const ref = sessionStorage.getItem(REF_KEY);
    if (ref) fields.ref = ref;
  } catch (err) {
    console.warn('[attribution] could not read ref:', err);
  }
  try {
    if (localStorage.getItem(GUEST_KEY) === '1') fields.viaGuest = true;
  } catch (err) {
    console.warn('[attribution] could not read guest flag:', err);
  }
  return fields;
}
