require('reflect-metadata');
const D = require('path').join(__dirname, '..', 'dist');
const L = require(D + '/bot/language');
const { BotEngine } = require(D + '/bot/bot.engine');

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ---- language detection
eq('hindi devanagari', L.detectLanguage('आपकी दुकान कहाँ है?'), 'hi');
eq('hinglish', L.detectLanguage('bhai iska price kitna hai'), 'hinglish');
eq('hinglish short', L.detectLanguage('kab khulta hai'), 'hinglish');
eq('english', L.detectLanguage('What are your opening hours?'), 'en');
eq('no signal', L.detectLanguage('price?'), null);
eq('emoji', L.detectLanguage('👍'), null);
eq('replyLanguage uses history', L.replyLanguage('auto', 'price?', ['mujhe ek shirt chahiye']), 'hinglish');
eq('replyLanguage forced', L.replyLanguage('hi', 'What is the price?'), 'hi');
eq('replyLanguage default en', L.replyLanguage('auto', 'ok'), 'en');

// ---- texts
eq('pickText hi default fallback translated', L.pickText(L.DEFAULT_FALLBACK_EN, '', 'hi', 'fallback'), L.say('fallback', 'hi'));
eq('pickText custom en kept for hinglish w/o hi', L.pickText('Call us at 99999', '', 'hinglish', 'fallback'), 'Call us at 99999');
eq('pickText hi version', L.pickText('Welcome!', 'स्वागत है!', 'hinglish'), 'स्वागत है!');

// ---- FAQ
const knowledge = `About us: Sharma Mobile Store, Ranchi.
Timings: 10 AM – 9 PM, Monday to Saturday. Sunday closed.
Delivery charges: ₹50 inside Ranchi, free above ₹999.

Q: Delivery kitne din me hoti hai?
A: Ranchi me same day, baaki Jharkhand me 2–3 din.

Q: Payment kaise kar sakte hain?
A: UPI, GPay, PhonePe, cash on delivery – sab chalta hai.

Q: Return policy kya hai?
A: 7 din me replacement milta hai agar box sealed ho.`;
const faqs = L.parseFaqs(knowledge);
eq('parsed faq count', faqs.length, 6);
const ask = (m) => (L.findFaq(faqs, m) || {}).q || null;
eq('faq: kab khulta hai', ask('dukan kab khulti hai?'), 'Timings');
eq('faq: what time do you open', ask('What time do you open?'), 'Timings');
eq('faq: hindi samay', ask('दुकान का समय क्या है'), 'Timings');
eq('faq: delivery kitne din', ask('delivery kitne din me aayegi'), 'Delivery kitne din me hoti hai?');
eq('faq: delivery charge', ask('delivery charge kitna lagega'), 'Delivery charges');
eq('faq: upi', ask('upi se pay kar sakte hai?'), 'Payment kaise kar sakte hain?');
eq('faq: refund hindi', ask('क्या रिफंड मिलेगा?'), 'Return policy kya hai?');
eq('faq: unrelated', ask('aaj mausam kaisa hai'), null);

// ---- products
const products = [
  { name: 'iPhone 15', price: 69999, currency: 'INR', inStock: true },
  { name: 'Samsung Galaxy S24', price: 74999, currency: 'INR', inStock: false },
  { name: 'Boat Earbuds', price: null, currency: 'INR', inStock: true },
];
eq('product iphone 15', L.matchProducts(products, 'iphone 15 ka price kya hai').map((p) => p.name), ['iPhone 15']);
eq('product galaxy s24', L.matchProducts(products, 'galaxy s24 available?').map((p) => p.name), ['Samsung Galaxy S24']);
eq('product none', L.matchProducts(products, 'charger hai?').length, 0);

// ---- engine end-to-end (AI off)
const prisma = { product: { findMany: async () => products } };
const llm = { enabled: false };
const engine = new BotEngine(prisma, llm);
const bot = {
  id: 'b', workspaceId: 'w', name: 'Test', aiEnabled: true, instructions: '', companyName: 'Sharma Mobile', location: 'Main Road, Ranchi',
  industry: '', assistantName: '', primaryGoal: '', supportEmail: '', websiteUrl: '', phoneNumbers: '9876543210', knowledge,
  welcomeMessage: '', fallbackMessage: L.DEFAULT_FALLBACK_EN, language: 'auto', welcomeMessageHi: '', fallbackMessageHi: '', useProducts: true,
  flows: [{ id: 'f', name: 'Menu', keywords: 'menu', matchType: 'exact', isNoMatch: false, enabled: true, priority: 0, steps: [{ position: 0, type: 'text', text: 'Menu: 1) Phones 2) Accessories' }] }],
};
const contact = { name: 'Ravi Kumar', waId: '919999999999' };
const run = async (msg, hist = []) => {
  const d = await engine.decide(bot, msg, msg, [...hist, { direction: 'in', body: msg }], contact);
  return { via: d.via, lang: d.lang, text: d.messages.map((m) => m.text).join(' | ') };
};
(async () => {
  const cases = [
    'hi', 'नमस्ते', 'Hello', 'dukan kahan hai?', 'Where is your shop?', 'आपका नंबर क्या है', 'iphone 15 ka price kya hai',
    'galaxy s24 available hai?', 'delivery kitne din me hogi', 'Do you accept UPI?', 'menu', 'ok thanks', '[audio message]',
    'mera order abhi tak nahi aaya, bahut late ho gaya', 'मुझे बात करनी है मैनेजर से',
  ];
  for (const c of cases) {
    const r = await run(c);
    console.log(`\n> ${c}\n  [${r.via}/${r.lang}] ${r.text}`);
  }
  eq('greeting hi in hindi', (await run('नमस्ते')).text.startsWith('नमस्ते Ravi'), true);
  eq('address answered', (await run('dukan kahan hai?')).via, 'faq');
  eq('fallback hinglish', (await run('mera order abhi tak nahi aaya, bahut late ho gaya')).text, L.say('fallback', 'hinglish'));
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})();
