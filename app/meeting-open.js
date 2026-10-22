const { calendarMeetingProvider } = require('./analytics-helpers');

const PREMEETING_LEAD_MS = 2 * 60 * 1000;
const LATE_WINDOW_MS = 5 * 60 * 1000;
const MODES = ['off', 'ask', 'auto'];
const PROVIDERS = ['meet', 'zoom', 'teams'];

// Defaults mirror src/config.py (auto_open_*); keep the two in sync.
function normalizeAutoOpenSettings(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const lead = cfg.auto_open_lead_minutes;
  return {
    mode: MODES.includes(cfg.auto_open_meetings) ? cfg.auto_open_meetings : 'off',
    leadMinutes: Number.isInteger(lead) && lead >= 0 && lead <= 30 ? lead : 1,
    providers: Array.isArray(cfg.auto_open_providers)
      ? [...new Set(cfg.auto_open_providers.filter((p) => PROVIDERS.includes(p)))]
      : [],
    acceptedOnly: cfg.auto_open_accepted_only !== false,
  };
}

function startMsOf(event) {
  if (!event || typeof event.start !== 'string' || !event.start.includes('T')) return NaN;
  if (event.is_all_day === true) return NaN;
  return new Date(event.start).getTime();
}

function isSafeMeetingUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch (_) {
    return false;
  }
}

// Returns 'auto' | 'ask' | null. ctx: {alreadyOpened, micActive, recordingOther, overlapping, allowAuto}
function decideMeetingOpen(event, settings, ctx, nowMs) {
  if (!settings || settings.mode === 'off') return null;
  const startMs = startMsOf(event);
  if (!isFinite(startMs)) return null;
  if (!isSafeMeetingUrl(event.meeting_url)) return null;
  if (event.response_status === 'declined') return null;
  if (settings.acceptedOnly && event.response_status !== 'accepted' && event.response_status !== 'organizer') return null;
  const provider = calendarMeetingProvider(event.meeting_url);
  if (settings.providers.length > 0 && !settings.providers.includes(provider)) return null;
  if (nowMs - startMs > LATE_WINDOW_MS) return null;
  const c = ctx || {};
  if (c.alreadyOpened) return null;
  if (settings.mode === 'ask') return 'ask';
  // An unknown host never opens without a click: invite links are attacker-controlled.
  if (provider === 'other' || c.micActive || c.recordingOther || c.overlapping || !c.allowAuto) return 'ask';
  return 'auto';
}

function planPremeetingTimers(events, settings, { premeetingEnabled, firedIds }, nowMs) {
  const plan = [];
  for (const event of events || []) {
    if (!event || (firedIds && firedIds.has(event.id))) continue;
    const startMs = startMsOf(event);
    if (!isFinite(startMs) || event.response_status === 'declined') continue;
    const openable = decideMeetingOpen(event, settings, { allowAuto: true }, nowMs) !== null;
    if (!openable && !premeetingEnabled) continue;
    const lead = openable ? settings.leadMinutes * 60 * 1000 : PREMEETING_LEAD_MS;
    const delayMs = startMs - lead - nowMs;
    if (delayMs > 0) plan.push({ event, delayMs });
    else if (openable) plan.push({ event, delayMs: 0 });
  }
  return plan;
}

module.exports = {
  PREMEETING_LEAD_MS,
  LATE_WINDOW_MS,
  normalizeAutoOpenSettings,
  decideMeetingOpen,
  planPremeetingTimers,
};
