// Join form shown at /r/:code when this browser has no session for the room.
import { $, showScreen } from '../dom.js';
import { errorMessage } from '../errors.js';

let submitHandler = null;

const PHASE_LABELS = { lobby: 'en el lobby', voting: 'votando', finished: 'terminada' };

// Renders from the public view ({ code, phase, playerCount, maxPlayers }): names are only shown to
// members, so the form says how many are in, not who.
export function showJoin(code, room, onSubmit) {
  submitHandler = onSubmit;
  $('joinRoomCode').textContent = code;
  const count = room.playerCount ?? room.players?.length ?? 0;
  const people = `${count} ${count === 1 ? 'jugador' : 'jugadores'}`;
  const phase = PHASE_LABELS[room.phase] ?? '';
  const midVote = room.phase === 'voting' ? ' Ya arrancaron: entrás votando desde la tarjeta actual.' : '';
  $('joinWho').textContent = `Sala ${code} · ${people}${phase ? ` · ${phase}` : ''}.${midVote}`;
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
