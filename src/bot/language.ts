/**
 * Hindi / English / Hinglish support — pure helpers, no I/O, easy to test.
 *
 *  - detectLanguage():   which language a customer message is written in
 *  - replyLanguage():    which language the bot should answer in (bot setting + conversation)
 *  - say():              built-in system texts (greeting, fallback, STOP/START, media) in all 3 languages
 *  - parseFaqs() / findFaq(): answers questions from the bot's "Training data" WITHOUT any AI key,
 *                        understanding Hindi, Hinglish and English words for the same thing
 *                        ("price" = "kitna" = "daam" = "कीमत").
 */
import { normalize } from './bot.logic';

export type Lang = 'en' | 'hi' | 'hinglish';
export type LangSetting = 'auto' | Lang;
export const LANG_SETTINGS: LangSetting[] = ['auto', 'en', 'hi', 'hinglish'];

// Hindi words commonly typed in English letters. Ambiguous English words ("me", "to", "main", "band", "hi") are left out on purpose.
const HINGLISH = new Set([
  'kya', 'kyaa', 'hai', 'hain', 'hei', 'ho', 'hoga', 'hogi', 'honge', 'tha', 'thi', 'the', 'kitna', 'kitne', 'kitni', 'kaise', 'kaisa', 'kaisi',
  'kab', 'kahan', 'kaha', 'kidhar', 'kyu', 'kyun', 'kyon', 'kaun', 'kon', 'konsa', 'kaunsa', 'kuch', 'mujhe', 'muje', 'mera', 'meri', 'mere',
  'aap', 'aapka', 'aapki', 'aapke', 'ap', 'apka', 'apki', 'apke', 'apna', 'apni', 'hum', 'hame', 'humein', 'tum', 'tera', 'teri', 'yeh', 'ye', 'woh', 'wo', 'vo',
  'chahiye', 'chaiye', 'chahie', 'chahta', 'chahti', 'bhai', 'bhaiya', 'bhaiyya', 'didi', 'sir', 'ji', 'nahi', 'nahin', 'nhi', 'haan', 'han', 'ha',
  'karo', 'kro', 'kare', 'karein', 'karna', 'karni', 'kijiye', 'dijiye', 'dena', 'lena', 'batao', 'btao', 'bataiye', 'bataye', 'bata', 'bta', 'bolo',
  'milega', 'milegi', 'milenge', 'milta', 'milti', 'sakta', 'sakte', 'sakti', 'wala', 'wali', 'wale', 'abhi', 'kal', 'aaj', 'jaldi', 'daam', 'kimat',
  'keemat', 'kimmat', 'paisa', 'paise', 'rupay', 'rupaye', 'rupees', 'dukan', 'dukaan', 'ghar', 'pata', 'samay', 'khulta', 'khulti', 'khulega',
  'bhejo', 'bhejiye', 'bhejna', 'bhejdo', 'aur', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'mai', 'toh', 'bhi', 'sirf', 'accha', 'acha', 'achha',
  'theek', 'thik', 'namaste', 'namaskar', 'shukriya', 'dhanyavad', 'dhanyawad', 'din', 'raat', 'subah', 'shaam', 'liye', 'liya', 'wahan', 'yahan',
  'idhar', 'udhar', 'matlab', 'samjha', 'samajh', 'pucha', 'puchna', 'sawal', 'jawab', 'hu', 'hoon', 'hun', 'rha', 'raha', 'rhi', 'rahi', 'gaya', 'gayi',
]);

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[a-z]/gi;

/** Language of one message, or null when it gives no signal (emoji, "ok", a number, "price?"). */
export function detectLanguage(text: string): Lang | null {
  const deva = (text.match(DEVANAGARI) || []).length;
  const latin = (text.match(LATIN) || []).length;
  if (deva && deva >= latin) return 'hi';
  if (!latin) return null;
  const words = normalize(text).split(' ').filter((w) => /^[a-z]+$/.test(w));
  if (!words.length) return null;
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  if (hits >= 2 || (hits === 1 && (words.length <= 3 || hits / words.length >= 0.2))) return 'hinglish';
  // Short English-looking messages ("price?") say little: let the conversation decide.
  return words.length >= 3 ? 'en' : null;
}

/**
 * The language to answer in. A fixed bot setting wins; on "auto" the newest customer message decides,
 * then earlier ones (so "price?" after a Hindi chat still gets Hindi), then English.
 */
export function replyLanguage(setting: string | null | undefined, latest: string, earlierCustomerMessages: string[] = []): Lang {
  if (setting === 'en' || setting === 'hi' || setting === 'hinglish') return setting;
  for (const t of [latest, ...[...earlierCustomerMessages].reverse()]) {
    const l = detectLanguage(t);
    if (l) return l;
  }
  return 'en';
}

export const LANG_LABEL: Record<Lang, string> = {
  en: 'English',
  hi: 'Hindi in Devanagari script (हिंदी)',
  hinglish: 'Hinglish — Hindi written in English letters, e.g. "Haan ji, ye available hai. Price ₹499 hai."',
};

// ---- Built-in texts
export const DEFAULT_FALLBACK_EN = 'Thanks for your message! Our team will reply shortly.';

const TEXTS = {
  greeting: {
    en: (n: string) => `Hello${n}! 👋 How can I help you today?`,
    hi: (n: string) => `नमस्ते${n}! 🙏 बताइए, मैं आपकी क्या मदद करूँ?`,
    hinglish: (n: string) => `Namaste${n}! 🙏 Bataiye, main aapki kya madad karun?`,
  },
  fallback: {
    en: () => DEFAULT_FALLBACK_EN,
    hi: () => 'आपके मैसेज के लिए धन्यवाद! 🙏 हमारी टीम जल्द ही आपको जवाब देगी।',
    hinglish: () => 'Message ke liye dhanyavaad! 🙏 Hamari team jald hi aapko reply karegi.',
  },
  stop: {
    en: () => 'You have been unsubscribed and will not get automatic replies. Send START to subscribe again.',
    hi: () => 'आपको अनसब्सक्राइब कर दिया गया है, अब ऑटोमैटिक मैसेज नहीं आएँगे। दोबारा शुरू करने के लिए START भेजें।',
    hinglish: () => 'Aapko unsubscribe kar diya gaya hai, ab automatic reply nahi aayenge. Dobara shuru karne ke liye START bhejiye.',
  },
  start: {
    en: () => 'Welcome back! You are subscribed again.',
    hi: () => 'वापसी पर स्वागत है! आप फिर से सब्सक्राइब हो गए हैं। 🙏',
    hinglish: () => 'Welcome back! Aap phir se subscribe ho gaye hain. 🙏',
  },
  media: {
    en: () => "Thanks, we got it! 🙂 I can only read typed messages — please type your question and I'll help. Our team will also check it.",
    hi: () => 'धन्यवाद, हमें मिल गया! 🙂 मैं सिर्फ़ लिखे हुए मैसेज पढ़ सकता हूँ — कृपया अपना सवाल टाइप करके भेजें। हमारी टीम भी इसे देख लेगी।',
    hinglish: () => 'Thank you, mil gaya! 🙂 Main sirf typed message padh sakta hoon — please apna sawal type karke bhejiye. Hamari team bhi ise dekh legi.',
  },
} as const;

export type TextKey = keyof typeof TEXTS;
export function say(key: TextKey, lang: Lang, name = ''): string {
  return TEXTS[key][lang](name ? ` ${name}` : '');
}

/**
 * Owner's message in the right language: the Hindi version (if they wrote one) for Hindi/Hinglish customers,
 * otherwise their English one. An untouched default fallback is translated automatically.
 */
export function pickText(english: string, hindi: string | null | undefined, lang: Lang, builtin?: TextKey): string {
  const en = (english || '').trim();
  const hi = (hindi || '').trim();
  if (lang !== 'en' && hi) return hi;
  if (lang !== 'en' && builtin && (!en || en === DEFAULT_FALLBACK_EN)) return say(builtin, lang);
  return en;
}

// ---- Media the bot cannot read (voice notes, photos without a caption …)
/** "[audio message]" style placeholders made by the WhatsApp session for messages without text. */
export function mediaKind(text: string): string | null {
  const m = /^\[(\w+) message\]$/.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

// ---- Offline FAQ answers (no AI key needed)

/** Words that mean the same thing in English, Hinglish and Hindi. */
const CONCEPTS: Record<string, string[]> = {
  price: ['price', 'prices', 'pricing', 'cost', 'costs', 'rate', 'rates', 'charge', 'charges', 'fee', 'fees', 'mrp', 'kimat', 'keemat', 'kimmat', 'daam', 'rupay', 'rupaye', 'kitna', 'kitne', 'kitni', 'कीमत', 'दाम', 'रेट', 'कितना', 'कितने', 'कितनी', 'शुल्क', 'फीस', 'चार्ज', 'प्राइस'],
  address: ['address', 'location', 'located', 'where', 'kahan', 'kaha', 'kidhar', 'pata', 'jagah', 'shop', 'store', 'office', 'dukan', 'dukaan', 'map', 'पता', 'कहाँ', 'कहां', 'दुकान', 'लोकेशन', 'एड्रेस', 'ऑफिस'],
  timing: ['time', 'timing', 'timings', 'hours', 'open', 'opening', 'close', 'closing', 'closed', 'kab', 'samay', 'khulta', 'khulti', 'khulega', 'baje', 'holiday', 'sunday', 'chutti', 'समय', 'कब', 'खुलता', 'खुलती', 'खुलेगा', 'बजे', 'टाइम', 'छुट्टी'],
  delivery: ['delivery', 'deliver', 'shipping', 'ship', 'courier', 'dispatch', 'bhejoge', 'bhejte', 'bhejenge', 'pahuncha', 'pahunchega', 'डिलीवरी', 'भेजेंगे', 'पहुँचेगा', 'कूरियर'],
  payment: ['payment', 'pay', 'paid', 'upi', 'gpay', 'paytm', 'phonepe', 'cash', 'cod', 'card', 'emi', 'online', 'bhugtan', 'भुगतान', 'पेमेंट', 'कैश'],
  contact: ['contact', 'phone', 'number', 'call', 'mobile', 'whatsapp', 'email', 'mail', 'sampark', 'संपर्क', 'नंबर', 'फोन', 'कॉल'],
  refund: ['return', 'returns', 'refund', 'exchange', 'replace', 'replacement', 'wapas', 'vapas', 'badalna', 'badal', 'वापस', 'रिफंड', 'बदलना', 'एक्सचेंज'],
  discount: ['discount', 'offer', 'offers', 'sale', 'coupon', 'deal', 'chhoot', 'chhut', 'sasta', 'छूट', 'ऑफर', 'डिस्काउंट', 'सस्ता'],
  booking: ['book', 'booking', 'appointment', 'reserve', 'reservation', 'slot', 'बुकिंग', 'अपॉइंटमेंट'],
  stock: ['stock', 'available', 'availability', 'uplabdh', 'उपलब्ध', 'स्टॉक'],
  website: ['website', 'site', 'link', 'web', 'वेबसाइट', 'लिंक'],
  service: ['service', 'services', 'kaam', 'product', 'products', 'item', 'items', 'menu', 'catalogue', 'catalog', 'सर्विस', 'काम', 'प्रोडक्ट'],
};
const CONCEPT_OF = new Map<string, string>();
for (const [id, words] of Object.entries(CONCEPTS)) for (const w of words) CONCEPT_OF.set(normalize(w), `#${id}`);

const STOP = new Set([
  // English
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'i', 'you', 'your', 'we', 'our', 'us', 'me',
  'my', 'it', 'its', 'this', 'that', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'what', 'which', 'how', 'much', 'many', 'please', 'pls', 'plz',
  'tell', 'know', 'want', 'need', 'have', 'has', 'any', 'there', 'about', 'from', 'at', 'by', 'sir', 'madam', 'mam', 'hello', 'hi', 'hey', 'get', 'give',
  // Hinglish
  'kya', 'hai', 'hain', 'ho', 'hoga', 'hogi', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'me', 'mai', 'main', 'aap', 'ap', 'aapka', 'aapki', 'aapke', 'apka', 'apki',
  'apke', 'mujhe', 'muje', 'mera', 'meri', 'mere', 'ye', 'yeh', 'wo', 'woh', 'vo', 'aur', 'bhi', 'toh', 'to', 'ji', 'bhai', 'bhaiya', 'batao', 'btao',
  'bataiye', 'bataye', 'bata', 'bta', 'chahiye', 'chaiye', 'karo', 'kare', 'karein', 'kijiye', 'dijiye', 'please', 'kuch', 'koi', 'hu', 'hoon', 'hun', 'tha', 'thi',
  'sakta', 'sakte', 'sakti', 'par', 'pe', 'liye', 'wala', 'wali', 'wale', 'kaise', 'kaisa', 'kaisi', 'kyu', 'kyun', 'kar', 'hota', 'hoti', 'hote',
  'milega', 'milegi', 'milenge', 'milta', 'milti', 'lagega', 'lagegi', 'lagta', 'lagti', 'rahe', 'raha', 'rahi', 'gaya', 'gayi', 'abhi', 'kab', 'tak',
  // Hindi
  'क्या', 'है', 'हैं', 'हो', 'का', 'की', 'के', 'को', 'से', 'में', 'मैं', 'आप', 'आपका', 'आपकी', 'आपके', 'मुझे', 'मेरा', 'मेरी', 'यह', 'ये', 'वो', 'वह', 'और',
  'भी', 'तो', 'जी', 'बताइए', 'बताओ', 'बताएं', 'चाहिए', 'करें', 'कीजिए', 'दीजिए', 'कृपया', 'कुछ', 'कोई', 'हूँ', 'था', 'थी', 'पर', 'लिए', 'वाला', 'वाली', 'कैसे',
  'मिलेगा', 'मिलेगी', 'मिलता', 'मिलती', 'लगेगा', 'होता', 'होती', 'सकते', 'सकता', 'सकती',
]);

/** Meaningful words of a sentence, with synonyms folded into one concept (#price, #address …). */
const HOW_MANY = new Set(['kitna', 'kitne', 'kitni', 'कितना', 'कितने', 'कितनी']);
const TIME_UNITS = new Set(['din', 'dino', 'dinon', 'ghanta', 'ghante', 'baje', 'minute', 'mahina', 'mahine', 'saal', 'days', 'day', 'hours', 'hour', 'दिन', 'दिनों', 'घंटे', 'घंटा', 'बजे', 'महीने', 'मिनट']);

export function keyTerms(text: string): Set<string> {
  const out = new Set<string>();
  const words = normalize(text).split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    // "kitne din" / "कितने दिन" asks about time, not price.
    if (HOW_MANY.has(w) && TIME_UNITS.has(words[i + 1] ?? '')) { out.add('#timing'); i++; continue; }
    const c = CONCEPT_OF.get(w);
    if (c) out.add(c);
    else if (!STOP.has(w) && (w.length > 2 || /[ऀ-ॿ]/.test(w)) && !/^\d+$/.test(w)) out.add(w.replace(/(.)\1+$/, '$1')); // "priceee" → "price"
  }
  return out;
}

export interface Faq { q: string; a: string }

const Q_MARK = /^\s*(?:q|ques|question|faq|sawal|prashn|प्रश्न|सवाल)\s*\d*\s*[:.)\-]\s*(.+)$/i;
const A_MARK = /^\s*(?:a|ans|answer|jawab|uttar|उत्तर|जवाब)\s*\d*\s*[:.)\-]\s*(.*)$/i;

/**
 * Questions and answers from the training data. Understands:
 *   Q: Delivery kitne din me hoti hai?        Question: What are your timings?
 *   A: 2–3 din me.                             Answer: 10 AM – 8 PM, Monday to Saturday.
 * and simple "Topic: answer" lines such as  "Timings: 10 AM – 8 PM"  or  "Delivery charges: ₹50".
 */
export function parseFaqs(knowledge: string | null | undefined): Faq[] {
  const lines = (knowledge || '').split(/\r?\n/);
  const faqs: Faq[] = [];
  let q: string | null = null;
  let a: string[] | null = null;
  const flush = () => {
    if (q && a && a.join(' ').trim()) faqs.push({ q, a: a.join('\n').trim() });
    q = null;
    a = null;
  };
  for (const line of lines) {
    const qm = Q_MARK.exec(line);
    if (qm) { flush(); q = qm[1].trim(); continue; }
    const am = A_MARK.exec(line);
    if (am && q) { a = [am[1]]; continue; }
    if (a) {
      if (!line.trim()) { flush(); continue; }
      a.push(line.trim());
      continue;
    }
    // "Topic: answer" line (short label, real answer)
    const kv = /^\s*([^:：]{2,40})[:：]\s*(.{2,})$/.exec(line);
    if (kv && !/https?$/i.test(kv[1].trim())) faqs.push({ q: kv[1].trim(), a: line.trim() });
  }
  flush();
  return faqs;
}

/** Best FAQ for a customer message, or null when nothing fits well enough. */
export function findFaq(faqs: Faq[], message: string): Faq | null {
  const m = keyTerms(message);
  if (!m.size) return null;
  let best: { f: Faq; overlap: number; score: number } | null = null;
  for (const f of faqs) {
    const q = keyTerms(f.q);
    if (!q.size) continue;
    let overlap = 0;
    for (const t of q) if (m.has(t)) overlap++;
    if (!overlap) continue;
    // Share of the FAQ question the customer asked about (topics count double), minus a little for
    // things in the message the FAQ doesn't talk about ("iphone price" must not get the "delivery charges" answer).
    const weight = (t: string) => (t.startsWith('#') ? 2 : 1);
    let have = 0;
    let total = 0;
    for (const t of q) { total += weight(t); if (m.has(t)) have += weight(t); }
    const extraTopics = [...m].filter((t) => t.startsWith('#') && !q.has(t)).length;
    const extraWords = [...m].filter((t) => !t.startsWith('#') && !q.has(t)).length;
    const score = have / total - extraTopics * 0.15 - Math.min(0.3, extraWords * 0.1);
    if (score < 0.5) continue;
    if (!best || overlap > best.overlap || (overlap === best.overlap && score > best.score)) best = { f, overlap, score };
  }
  return best?.f ?? null;
}

// ---- Product questions without AI
export interface ProductLike { name: string; price: number | null; currency: string; inStock: boolean; description?: string }

/** Products the customer named ("iphone 15 ka price?"). At most 3. */
export function matchProducts<P extends ProductLike>(products: P[], message: string): P[] {
  const msg = ` ${normalize(message)} `;
  const words = new Set(normalize(message).split(' '));
  const scored = products
    .map((p) => {
      const name = normalize(p.name);
      if (!name) return { p, s: 0 };
      if (msg.includes(` ${name} `)) return { p, s: 100 + name.length };
      const parts = name.split(' ').filter((w) => w.length > 2 || /\d/.test(w));
      const hit = parts.filter((w) => words.has(w)).length;
      return { p, s: parts.length && hit >= Math.min(2, parts.length) ? hit / parts.length : 0 };
    })
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, 3).map((x) => x.p);
}

const money = (p: ProductLike) => (p.price == null ? null : `${p.currency === 'INR' ? '₹' : `${p.currency} `}${p.price.toLocaleString('en-IN')}`);

export function productReply(products: ProductLike[], lang: Lang): string {
  const line = (p: ProductLike) => {
    const price = money(p);
    if (lang === 'hi') return `• *${p.name}*: ${price ?? 'कीमत के लिए पूछें'} — ${p.inStock ? 'स्टॉक में है ✅' : 'अभी स्टॉक में नहीं है ❌'}`;
    if (lang === 'hinglish') return `• *${p.name}*: ${price ?? 'price ke liye puchiye'} — ${p.inStock ? 'stock me hai ✅' : 'abhi stock me nahi hai ❌'}`;
    return `• *${p.name}*: ${price ?? 'price on request'} — ${p.inStock ? 'in stock ✅' : 'currently out of stock ❌'}`;
  };
  const head = lang === 'hi' ? 'ये रही जानकारी:' : lang === 'hinglish' ? 'Ye rahi details:' : "Here are the details:";
  const tail = lang === 'hi' ? 'ऑर्डर करना हो तो बताइए 🙂' : lang === 'hinglish' ? 'Order karna ho to bataiye 🙂' : 'Let me know if you would like to order 🙂';
  return `${head}\n${products.map(line).join('\n')}\n\n${tail}`;
}

/** Business details (address, phone …) as ready answers, in the customer's language. */
export function businessFaqs(b: { companyName?: string; location?: string; phoneNumbers?: string; supportEmail?: string; websiteUrl?: string }, lang: Lang): Faq[] {
  const L = (en: string, hi: string, hg: string) => (lang === 'hi' ? hi : lang === 'hinglish' ? hg : en);
  const out: Faq[] = [];
  if (b.location?.trim()) out.push({ q: 'address location', a: `📍 ${L('Our address', 'हमारा पता', 'Hamara address')}: ${b.location.trim()}` });
  const contact = [b.phoneNumbers?.trim() && `📞 ${b.phoneNumbers.trim().replace(/\s*\n\s*/g, ', ')}`, b.supportEmail?.trim() && `✉️ ${b.supportEmail.trim()}`].filter(Boolean).join('\n');
  if (contact) out.push({ q: 'contact', a: `${L('You can reach us here', 'आप हमसे यहाँ संपर्क कर सकते हैं', 'Aap humse yahan contact kar sakte hain')}:\n${contact}` });
  if (b.websiteUrl?.trim()) out.push({ q: 'website', a: `🌐 ${L('Our website', 'हमारी वेबसाइट', 'Hamari website')}: ${b.websiteUrl.trim()}` });
  return out;
}
