const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAutoOpenSettings,
  decideMeetingOpen,
  planPremeetingTimers,
} = require('./meeting-open');

const NOW = Date.parse('2026-01-01T10:00:00Z');
const MIN = 60 * 1000;
const iso = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();

const settings = (over = {}) => ({ mode: 'auto', leadMinutes: 1, providers: [], acceptedOnly: true, ...over });
const ev = (over = {}) => ({
  id: 'e1',
  title: 'Standup',
  start: iso(5),
  end: iso(35),
  meeting_url: 'https://meet.google.com/abc-defg-hij',
  response_status: 'accepted',
  is_all_day: false,
  ...over,
});
const ctx = (over = {}) => ({ allowAuto: true, ...over });
const decide = (e, s, c) => decideMeetingOpen(e, s, c || ctx(), NOW);

test('normalizeAutoOpenSettings defaults and clamping', () => {
  assert.deepEqual(normalizeAutoOpenSettings(null), { mode: 'off', leadMinutes: 1, providers: [], acceptedOnly: true });
  assert.deepEqual(
    normalizeAutoOpenSettings({
      auto_open_meetings: 'auto',
      auto_open_lead_minutes: 5,
      auto_open_providers: ['meet', 'meet', 'bogus', 'zoom'],
      auto_open_accepted_only: false,
    }),
    { mode: 'auto', leadMinutes: 5, providers: ['meet', 'zoom'], acceptedOnly: false },
  );
  for (const bad of [31, -1, 1.5, true, '2', null]) {
    assert.equal(normalizeAutoOpenSettings({ auto_open_lead_minutes: bad }).leadMinutes, 1);
  }
  assert.equal(normalizeAutoOpenSettings({ auto_open_meetings: 'nope' }).mode, 'off');
});

test('null rules', () => {
  assert.equal(decide(ev(), settings({ mode: 'off' })), null);
  for (const url of ['ftp://x/y', 'javascript:alert(1)', 'not a url', '', undefined, 'https://user@meet.google.com/x', 'https://u:p@meet.google.com/x']) {
    assert.equal(decide(ev({ meeting_url: url }), settings()), null, String(url));
  }
  assert.equal(decide(ev({ is_all_day: true }), settings()), null);
  assert.equal(decide(ev({ start: '2026-01-01' }), settings()), null);
  assert.equal(decide(ev({ response_status: 'declined' }), settings({ acceptedOnly: false })), null);
  assert.equal(decide(ev(), settings(), ctx({ alreadyOpened: true })), null);
});

test('accepted-only response statuses', () => {
  const s = settings();
  for (const ok of ['accepted', 'organizer']) assert.equal(decide(ev({ response_status: ok }), s), 'auto', ok);
  for (const no of ['tentative', 'needsAction', 'unknown', undefined]) {
    assert.equal(decide(ev({ response_status: no }), s), null, String(no));
    assert.equal(decide(ev({ response_status: no }), settings({ acceptedOnly: false })), 'auto', String(no));
  }
});

test('provider filter uses the hostname', () => {
  const s = settings({ providers: ['meet'] });
  assert.equal(decide(ev(), s), 'auto');
  assert.equal(decide(ev({ meeting_url: 'https://zoom.us/j/1' }), s), null);
  assert.equal(decide(ev({ meeting_url: 'https://evil.com/meet.google.com' }), s), null);
  assert.equal(decide(ev({ meeting_url: 'https://meet.google.com.evil.com/x' }), s), null);
  assert.equal(decide(ev({ meeting_url: 'https://meet.google.com@evil.com/x' }), s), null);
});

test('late window', () => {
  assert.equal(decideMeetingOpen(ev({ start: iso(-4) }), settings(), ctx(), NOW), 'auto');
  assert.equal(decideMeetingOpen(ev({ start: iso(-6) }), settings(), ctx(), NOW), null);
});

test('offset time strings', () => {
  const start = new Date(NOW + 5 * MIN);
  const offset = start.toISOString().replace('Z', '+00:00');
  assert.equal(decide(ev({ start: offset }), settings()), 'auto');
  assert.equal(decide(ev({ start: '2026-01-01T05:05:00-05:00' }), settings()), 'auto');
});

test('ask mode always asks; auto downgrades to ask', () => {
  assert.equal(decide(ev(), settings({ mode: 'ask' })), 'ask');
  assert.equal(decide(ev(), settings()), 'auto');
  assert.equal(decide(ev({ meeting_url: 'https://example.com/call' }), settings()), 'ask');
  assert.equal(decide(ev(), settings(), ctx({ micActive: true })), 'ask');
  assert.equal(decide(ev(), settings(), ctx({ recordingOther: true })), 'ask');
  assert.equal(decide(ev(), settings(), ctx({ overlapping: true })), 'ask');
  assert.equal(decide(ev(), settings(), { allowAuto: false }), 'ask');
});

test('planPremeetingTimers', () => {
  const base = { premeetingEnabled: true, firedIds: new Set() };
  const plan = (events, s, o) => planPremeetingTimers(events, s, { ...base, ...o }, NOW);

  assert.deepEqual(plan([ev()], settings({ leadMinutes: 1 })).map((p) => p.delayMs), [4 * MIN]);
  assert.deepEqual(plan([ev()], settings({ leadMinutes: 0 })).map((p) => p.delayMs), [5 * MIN]);

  const noUrl = ev({ id: 'x', meeting_url: undefined });
  assert.deepEqual(plan([noUrl], settings()).map((p) => p.delayMs), [3 * MIN]);
  assert.deepEqual(plan([noUrl], settings({ mode: 'off' })).map((p) => p.delayMs), [3 * MIN]);
  assert.deepEqual(plan([noUrl], settings(), { premeetingEnabled: false }), []);

  assert.deepEqual(plan([ev({ start: iso(0.5) })], settings({ leadMinutes: 1 })).map((p) => p.delayMs), [0]);
  assert.deepEqual(plan([ev({ start: iso(-3) })], settings()).map((p) => p.delayMs), [0]);
  assert.deepEqual(plan([ev({ start: iso(-6) })], settings()), []);
  assert.deepEqual(plan([ev({ id: 'y', start: iso(1) })], settings({ leadMinutes: 5 }), { premeetingEnabled: false }).map((p) => p.delayMs), [0]);

  assert.deepEqual(plan([ev()], settings(), { firedIds: new Set(['e1']) }), []);
  assert.deepEqual(plan([ev({ is_all_day: true }), ev({ id: 'd', response_status: 'declined' })], settings()), []);
  assert.deepEqual(plan([ev()], settings(), { premeetingEnabled: false }).map((p) => p.delayMs), [4 * MIN]);
});
