import { $, showScreen } from '../dom.js';
import { errorMessage, errorTitle } from '../errors.js';

let retryHandler = null;

// onRetry: optional callback; without it only "Ir al inicio" is offered.
export function showError(code, { onRetry = null } = {}) {
  $('errorTitle').textContent = errorTitle(code);
  $('errorMessage').textContent = errorMessage(code);
  retryHandler = onRetry;
  $('errorRetryBtn').hidden = !onRetry;
  showScreen('errorScreen');
  $('errorTitle').focus?.();
}

export function bindError() {
  $('errorRetryBtn').addEventListener('click', () => retryHandler?.());
}
