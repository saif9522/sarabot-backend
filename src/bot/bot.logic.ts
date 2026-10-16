/** Pure helpers for the bot engine — no I/O, easy to test. */

export interface WorkingHours { workDays: string; workStart: string; workEnd: string; timezone: string }
export interface RuleLike { keywords: string; matchType: string; priority: number; enabled: boolean }

/** Weekday (0 = Sunday) and minutes since midnight in the account's timezone. */
export function localTime(date: Date, timezone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Supports overnight ranges like 20:00–02:00 (the early hours count for the previous day). */
export function isWorkingHours(h: WorkingHours, now = new Date()): boolean {
  const days = new Set(h.workDays.split(',').map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6));
  const { day, minutes } = localTime(now, h.timezone);
  const start = toMinutes(h.workStart);
  const end = toMinutes(h.workEnd);
  if (start === end) return days.has(day); // all day
  if (start < end) return days.has(day) && minutes >= start && minutes < end;
  if (minutes >= start) return days.has(day);
  return minutes < end && days.has((day + 6) % 7);
}

/** Lowercase, trim and collapse spaces/punctuation so "Price?!" matches "price". */
export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function ruleMatches(rule: RuleLike, text: string): boolean {
  if (!rule.enabled) return false;
  const t = normalize(text);
  if (!t) return false;
  return rule.keywords
    .split(',')
    .map(normalize)
    .filter(Boolean)
    .some((k) => {
      if (rule.matchType === 'exact') return t === k;
      if (rule.matchType === 'starts') return t === k || t.startsWith(k + ' ');
      return ` ${t} `.includes(` ${k} `); // whole words / phrases
    });
}

/** Highest priority first, then most specific (longest keyword). */
export function findRule<R extends RuleLike>(rules: R[], text: string): R | undefined {
  return rules
    .filter((r) => ruleMatches(r, text))
    .sort((a, b) => b.priority - a.priority || longest(b) - longest(a))[0];
}
const longest = (r: RuleLike) => Math.max(...r.keywords.split(',').map((k) => k.trim().length));

/** {name} and {number} placeholders in replies. */
export function render(template: string, vars: { name?: string | null; number: string }): string {
  const first = (vars.name || '').trim().split(/\s+/)[0] || 'there';
  return template.replace(/\{name\}/gi, first).replace(/\{number\}/gi, vars.number);
}

export type OptCommand = 'stop' | 'start' | null;
export function optCommand(text: string): OptCommand {
  const t = normalize(text);
  if (['stop', 'unsubscribe', 'stop all', 'band karo'].includes(t)) return 'stop';
  if (['start', 'subscribe', 'unstop'].includes(t)) return 'start';
  return null;
}

/** Pick the products most relevant to the question so the AI prompt stays small. */
export function relevantProducts<P extends { name: string; description: string; sku?: string | null; categoryName?: string | null }>(
  products: P[], question: string, limit = 40,
): P[] {
  if (products.length <= limit) return products;
  const q = new Set(normalize(question).split(' ').filter((w) => w.length > 2));
  return products
    .map((p) => ({ p, s: normalize(`${p.name} ${p.description} ${p.sku ?? ''} ${p.categoryName ?? ''}`).split(' ').filter((w) => q.has(w)).length }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);
}

// ---- Messages the bot should not answer at all
const ACKS = new Set([
  'ok', 'okay', 'okk', 'okkk', 'oki', 'k', 'kk', 'hmm', 'hm', 'hmmm', 'hmmmm', 'acha', 'accha', 'achha', 'achaa', 'acchha',
  'theek hai', 'thik hai', 'thick hai', 'theek', 'thik', 'thanks', 'thank you', 'thanku', 'thank u', 'thnx', 'thx', 'ty', 'tq',
  'shukriya', 'dhanyavad', 'dhanyawad', 'done', 'fine', 'cool', 'nice', 'good', 'great', 'alright', 'sure', 'yes', 'no', 'haan', 'han', 'ha',
  'ji', 'ji haan', 'nahi', 'na', 'bye', 'tc', 'gn', 'gm', 'ठीक है', 'धन्यवाद', 'ओके', 'हाँ', 'जी',
]);
const ABUSE_WORDS = new Set(['mc', 'bc', 'bsdk', 'bkl', 'mkc', 'tmkc', 'bhenchod', 'gandu', 'gaandu', 'lund', 'lauda', 'laude', 'lavde', 'randi', 'harami', 'kamina', 'kamine', 'chutiya', 'chutiye', 'chutia', 'fuck', 'fck', 'bitch', 'bastard', 'asshole', 'shit']);
const ABUSE_PREFIXES = ['bhosd', 'bhosad', 'bhasud', 'bhosr', 'madarch', 'maderch', 'madarc', 'behench', 'bhench', 'behanch', 'chutiy', 'motherf', 'fuck', 'randw', 'भोसड', 'मादरच', 'बहनच', 'चुतिय', 'गांडू', 'रंडी'];

/**
 * Returns why a message should get no reply (acknowledgement, emoji-only, too short, abusive),
 * or null when it is worth answering. Flows are checked before this, so "hi" can still trigger
 * a greeting flow.
 */
export function noiseReason(text: string): 'empty' | 'acknowledgement' | 'abusive' | null {
  const t = normalize(text);
  if (!t || t.replace(/\s/g, '').length <= 1) return 'empty';
  const words = t.split(' ');
  if (words.some((w) => ABUSE_WORDS.has(w) || ABUSE_PREFIXES.some((p) => w.startsWith(p)))) return 'abusive';
  if (ACKS.has(t) || ACKS.has(t.replace(/(.)\1{2,}/g, '$1$1'))) return 'acknowledgement';
  return null;
}

const GREETINGS = new Set([
  'hi', 'hii', 'hey', 'heyy', 'hello', 'helo', 'hlo', 'hallo', 'hola', 'yo', 'hi there', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening', 'morning', 'namaste', 'namaskar', 'namaskaram', 'salaam', 'salam',
  'assalamualaikum', 'assalam alaikum', 'sat sri akal', 'ram ram', 'jai shri krishna', 'radhe radhe', 'नमस्ते', 'नमस्कार', 'हेलो', 'हाय',
]);

/** True when the whole message is just a greeting ("hi", "Hello!!", "good morning"). Repeated letters are tolerated ("hiiii"). */
export function isGreeting(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  return GREETINGS.has(t) || GREETINGS.has(t.replace(/(.)\1+/g, '$1$1')) || GREETINGS.has(t.replace(/(.)\1+/g, '$1'));
}
