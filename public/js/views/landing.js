// Landing: create a room (host) or jump to a room by code.
import { $, showScreen } from '../dom.js';
import { api } from '../api.js';
import { saveSession } from '../store.js';
import { extractCode } from '../code.js';
import { errorMessage } from '../errors.js';
import { attributionFields } from '../attribution.js';

export function showLanding() {
  showScreen('landingScreen');
  $('createError').textContent = '';
  $('joinCodeError').textContent = '';
}

async function createRoom(navigate) {
  const hostName = $('hostName').value.trim();
  if (!hostName) {
    $('createError').textContent = 'Poné tu nombre para crear la sala.';
    return $('hostName').focus();
  }
  $('createBtn').disabled = true;
  try {
    const { code, hostToken, playerToken, playerId } = await api.createRoom(hostName, attributionFields());
    saveSession(code, { hostToken, playerToken, playerId });
    navigate(`/r/${code}`);
  } catch (err) {
    $('createError').textContent = errorMessage(err.code);
  } finally {
    $('createBtn').disabled = false;
  }
}

function joinByCode(navigate) {
  const code = extractCode($('joinCode').value);
  if (!code) {
    $('joinCodeError').textContent = errorMessage('invalid_code');
    return $('joinCode').focus();
  }
  navigate(`/r/${code}`);
}

export function bindLanding(navigate) {
  $('createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    createRoom(navigate);
  });
  $('joinCodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    joinByCode(navigate);
  });
}
