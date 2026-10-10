// Friendly Spanish copy for every error code in docs/API.md (plus client-side ones).

const MESSAGES = {
  invalid_name: 'El nombre tiene que tener entre 1 y 16 caracteres, sin símbolos raros.',
  rate_limited: 'Vas muy rápido. Esperá un ratito y probá de nuevo.',
  capacity: 'Estamos a full de salas ahora mismo. Probá de nuevo en unos minutos.',
  room_not_found: 'Esa sala no existe o ya expiró. Revisá el código o creá una nueva.',
  name_taken: 'Ya hay alguien con ese nombre en la sala. Probá con otro (o agregale un apodo).',
  room_full: 'La sala está llena: entran hasta 12 jugadores.',
  room_finished: 'Esta votación ya terminó. Pedile al host que arme otra sala.',
  invalid_filters: 'Esos filtros no son válidos. Revisalos y probá de nuevo.',
  unauthorized: 'Tu sesión en esta sala no es válida. Volvé a entrar con tu nombre.',
  not_host: 'Eso solo lo puede hacer el host de la sala.',
  already_started: 'La votación ya arrancó.',
  empty_deck: 'Ningún juego pasa esos filtros. Aflojá alguno y probá de nuevo.',
  invalid_vote: 'No pudimos registrar ese voto. Probá de nuevo.',
  not_current_game: 'Esa tarjeta ya se cerró: votá la que sigue.',
  not_voting: 'No hay ninguna votación en curso.',
  nothing_to_undo: 'No hay nada para deshacer.',
  unknown_game: 'No encontramos ese juego.',
  steam_unavailable: 'Steam no responde ahora: algunos datos del juego pueden faltar.',
  invalid_json: 'El servidor no entendió el pedido. Recargá la página y probá de nuevo.',
  bad_request: 'El servidor no entendió el pedido. Recargá la página y probá de nuevo.',
  body_too_large: 'Ese texto es demasiado largo.',
  unsupported_media_type: 'El servidor no entendió el pedido. Recargá la página y probá de nuevo.',
  not_found: 'No encontramos lo que buscabas.',
  method_not_allowed: 'Esa acción no está permitida.',
  internal: 'Se nos rompió algo del lado del servidor. Probá de nuevo en un ratito.',
  network: 'Sin conexión con el servidor. Revisá tu internet y probá de nuevo.',
  invalid_code: 'Ese código no parece válido: son 6 letras o números (por ej. K7Q2MX).',
  closed: 'La sala se cerró por inactividad (2 horas sin movimiento). Creá una nueva para seguir.',
};

const TITLES = {
  room_not_found: 'Sala no encontrada',
  room_full: 'Sala llena',
  room_finished: 'Votación terminada',
  closed: 'La sala expiró',
  invalid_code: 'Código inválido',
  network: 'Sin conexión',
  capacity: 'Estamos a full',
};

export function errorMessage(code) {
  return MESSAGES[code] || 'Algo salió mal. Probá de nuevo.';
}

export function errorTitle(code) {
  return TITLES[code] || 'Uy, algo falló';
}
