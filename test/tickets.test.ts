import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamTicketStore, TICKET_PATTERN, TICKET_TTL_MS } from '../src/tickets.ts';

function makeTickets() {
  const clock = { t: 1_000_000 };
  return { tickets: new StreamTicketStore({ now: () => clock.t }), clock };
}

describe('StreamTicketStore', () => {
  test('tickets are 128-bit base64url and unique', () => {
    const { tickets } = makeTickets();
    const issued = new Set(Array.from({ length: 50 }, (_, i) => tickets.issue('ROOM01', `p_${i}`)));
    assert.equal(issued.size, 50);
    for (const t of issued) assert.match(t, TICKET_PATTERN);
  });

  test('single use, bound to the room', () => {
    const { tickets } = makeTickets();
    const t = tickets.issue('ROOM01', 'p_1');
    assert.equal(tickets.consume(t, 'ROOM02'), null, 'other room');
    assert.equal(tickets.consume(t, 'ROOM01'), null, 'a failed attempt burns it too');
    const u = tickets.issue('ROOM01', 'p_1');
    assert.equal(tickets.consume(u, 'ROOM01'), 'p_1');
    assert.equal(tickets.consume(u, 'ROOM01'), null, 'reuse');
    assert.equal(tickets.consume('nope', 'ROOM01'), null);
    assert.equal(tickets.size, 0);
  });

  test('expires after 30 s and prune frees memory', () => {
    const { tickets, clock } = makeTickets();
    const t = tickets.issue('ROOM01', 'p_1');
    tickets.issue('ROOM01', 'p_2');
    clock.t += TICKET_TTL_MS;
    assert.equal(tickets.consume(t, 'ROOM01'), null);
    tickets.prune();
    assert.equal(tickets.size, 0);
  });

  test('at most 4 outstanding per player; dropRoom clears a room', () => {
    const { tickets } = makeTickets();
    const first = tickets.issue('ROOM01', 'p_1');
    for (let i = 0; i < 4; i += 1) tickets.issue('ROOM01', 'p_1');
    assert.equal(tickets.size, 4);
    assert.equal(tickets.consume(first, 'ROOM01'), null, 'the oldest was dropped');
    tickets.issue('ROOM02', 'p_9');
    tickets.dropRoom('ROOM01');
    assert.equal(tickets.size, 1);
  });
});
