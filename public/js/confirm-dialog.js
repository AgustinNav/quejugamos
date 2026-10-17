// In-app confirmation dialog (replaces the browser's native confirm dialog, which blocks the page, ignores our
// styling and is suppressed by some embedded browsers). One static <dialog id="confirmDialog"> in
// index.html; showModal() gives the focus trap and the Esc key. Text always goes in through
// textContent, so a player name can never inject markup.
import { $ } from './dom.js';

let settle = null; // resolves the open dialog's promise; null when closed
let returnFocusTo = null;

function finish(result) {
  if (!settle) return;
  const resolve = settle;
  settle = null;
  window.removeEventListener('keydown', onKeydown, true);
  const dialog = $('confirmDialog');
  if (dialog.open) dialog.close();
  if (returnFocusTo?.isConnected && returnFocusTo.offsetParent !== null) returnFocusTo.focus();
  returnFocusTo = null;
  resolve(result);
}

// Capture phase on window, like the gallery and the ranking sheet: vote/host shortcuts must not
// fire behind the dialog. Tab/Enter/Space/Esc keep their default behavior.
function onKeydown(e) {
  if (e.key !== 'Escape') e.stopImmediatePropagation();
}

/**
 * Asks the user to confirm. Resolves true only on the confirm button; Esc, a click on the backdrop
 * or the cancel button resolve false. Opening a second one cancels the first.
 * @param {{ title: string, body?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function askConfirm({ title, body = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  finish(false);
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmBody').hidden = !body;
  $('confirmOk').textContent = confirmLabel;
  $('confirmCancel').textContent = cancelLabel;
  $('confirmOk').classList.toggle('danger', danger);
  returnFocusTo = document.activeElement;
  return new Promise((resolve) => {
    settle = resolve;
    window.addEventListener('keydown', onKeydown, true);
    dialog.showModal();
    // A destructive action never has focus by default: Enter/Space must not delete by reflex.
    (danger ? $('confirmCancel') : $('confirmOk')).focus();
  });
}

/** Cancels an open dialog (the room went away underneath it). */
export const dismissConfirm = () => finish(false);

export function bindConfirmDialog() {
  const dialog = $('confirmDialog');
  $('confirmOk').addEventListener('click', () => finish(true));
  $('confirmCancel').addEventListener('click', () => finish(false));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc
  dialog.addEventListener('close', () => finish(false));
  // A click on the backdrop lands on the <dialog> itself.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); });
}
