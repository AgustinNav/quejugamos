import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { bearerToken, clientIp, createRateLimiter, parsePathname, safeDecode } from '../src/http.ts';
import { createLogger } from '../src/log.ts';

function fakeReq(headers: Record<string, string | string[]>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('clientIp', () => {
  test('ignores X-Forwarded-For with 0 trusted hops', () => {
    assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '1.2.3.4' }), 0), '127.0.0.1');
  });

  test('uses the rightmost entry, which the client cannot forge', () => {
    assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), 1), '203.0.113.7');
    assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '2001:db8::1' }), 1), '2001:db8::1');
  });

  test('with 2 hops skips the proxy entry and ignores forged entries further left', () => {
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.9' });
    assert.equal(clientIp(req, 2), '203.0.113.7');
  });

  test('falls back to the socket address when there are fewer entries than hops', () => {
    assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7' }), 2), '127.0.0.1');
  });

  test('falls back to the socket address on missing or garbage header', () => {
    assert.equal(clientIp(fakeReq({}), 1), '127.0.0.1');
    assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '1.1.1.1, <script>' }), 1), '127.0.0.1');
  });
});

describe('helpers', () => {
  test('bearerToken', () => {
    assert.equal(bearerToken(fakeReq({ authorization: 'Bearer abc-123' })), 'abc-123');
    assert.equal(bearerToken(fakeReq({ authorization: 'Basic abc' })), null);
    assert.equal(bearerToken(fakeReq({ authorization: 'Bearer ' })), null);
    assert.equal(bearerToken(fakeReq({})), null);
  });

  test('safeDecode and parsePathname never throw', () => {
    assert.equal(safeDecode('%E0%A4%A'), null);
    assert.equal(safeDecode('a%20b'), 'a b');
    assert.equal(parsePathname('/a?b=1'), '/a');
    assert.equal(parsePathname('http://[garbage'), null);
  });

  test('rate limiter counts per key within the window', () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter(1000, 2, () => clock.t);
    assert.equal(limiter.hit('a'), false);
    assert.equal(limiter.hit('a'), false);
    assert.equal(limiter.hit('a'), true);
    assert.equal(limiter.hit('b'), false);
    clock.t = 1001;
    assert.equal(limiter.hit('a'), false);
  });

  test('logger writes one JSON line with severity', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l))('room_created', { roomCode: 'ABC234' });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.severity, 'INFO');
    assert.equal(entry.event, 'room_created');
    assert.equal(entry.roomCode, 'ABC234');
  });
});
