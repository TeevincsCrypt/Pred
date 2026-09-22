import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus, nextRegularClose, nextRegularOpen, nyWallToUtc } from '../src/market/hours.js';

test('weekend is closed and next open is Monday 09:30 ET', () => {
  const s = marketStatus(Date.parse('2026-09-20T21:00:00Z')); // Sun 17:00 ET
  assert.equal(s.session, 'WEEKEND');
  assert.equal(s.usMarketOpen, false);
  assert.equal(new Date(s.nextOpen).toISOString(), '2026-09-21T13:30:00.000Z');
});

test('sessions on a regular weekday (EDT)', () => {
  assert.equal(marketStatus(Date.parse('2026-09-21T11:00:00Z')).session, 'PRE_MARKET');
  assert.equal(marketStatus(Date.parse('2026-09-21T14:00:00Z')).session, 'REGULAR');
  assert.equal(marketStatus(Date.parse('2026-09-21T21:00:00Z')).session, 'AFTER_HOURS');
  assert.equal(marketStatus(Date.parse('2026-09-22T02:00:00Z')).session, 'OVERNIGHT');
});

test('winter time (EST) offset', () => {
  assert.equal(new Date(nyWallToUtc('2026-01-15', 9, 30)).toISOString(), '2026-01-15T14:30:00.000Z');
});

test('holidays and early closes', () => {
  assert.equal(marketStatus(Date.parse('2026-11-26T16:00:00Z')).session, 'HOLIDAY'); // Thanksgiving
  assert.equal(new Date(nextRegularClose(Date.parse('2026-11-27T15:00:00Z'))).toISOString(), '2026-11-27T18:00:00.000Z'); // 13:00 ET
  assert.equal(new Date(nextRegularOpen(Date.parse('2026-12-24T20:00:00Z'))).toISOString(), '2026-12-28T14:30:00.000Z');
});
