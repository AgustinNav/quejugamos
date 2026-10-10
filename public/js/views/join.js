// Join form shown at /r/:code when this browser has no session for the room.
import { $, showScreen } from '../dom.js';
import { errorMessage } from '../errors.js';

let submitHandler = null;

export function showJoin(code, snapshot, onSubmit) {
  submitHandler = onSubmit;
  $('joinRoomCode').textContent = code;
  const host = snapshot.players.find((p) => p.isHost);
  const others = snapshot.players.length - 1;
  const already = others > 0 ? ` y ${others} ${others === 1 ? 'amigo más' : 'amigos más'}` : '';
  const verb = others > 0 ? 'Están' : 'Está';
  const midVote = snapshot.phase === 'voting' ? ' Ya arrancaron: entrás votando desde la tarjeta actual.' : '';
  $('joinWho').textContent = host ? `${verb} ${host.name}${already}.${midVote}` : '';
  $('joinError').textContent = '';
  showScreen('joinScreen');
  $('joinName').focus();
}

export function setJoinError(code) {
  $('joinError').textContent = errorMessage(code);
}

export function bindJoin() {
  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('joinName').value.trim();
    if (!name) return setJoinError('invalid_name');
    $('joinBtn').disabled = true;
    try {
      await submitHandler?.(name);
    } finally {
      $('joinBtn').disabled = false;
    }
  });
}
