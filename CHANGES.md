# Changes — Hindi/English bot + fixes (22 Oct 2026)

## 1. Deploy steps (do these in order)

1. **Database**: the 3 new `Bot` columns are now added automatically when the app starts
   (src/prisma.service.ts). You can also add them by hand: `prisma/manual/2026-10-22-bot-language.sql`.
2. **SESSION_SECRET**: make sure it is set on Render (32+ random characters, `openssl rand -hex 32`).
   If it is already set, keep the same value (changing it unlinks WhatsApp numbers and clears saved API keys).
   The app now refuses to start on Render / `NODE_ENV=production` without it.
3. Deploy backend, then frontend.
4. Check: `npm run build && npm run test:bot` → should print `ALL PASSED`.

## 2. Hindi / English / Hinglish

- **Auto language**: the bot answers in the customer's language —
  `कीमत क्या है?` → Hindi, `price kitna hai?` → Hinglish, `What is the price?` → English.
  A short message like "price?" follows the earlier chat's language.
- **Bot → Settings → Reply language**: Auto / Always English / Always Hindi / Always Hinglish.
- **Hindi welcome & fallback** fields. Left empty, the default fallback is translated automatically.
- Greeting, fallback, STOP/START replies, and the "voice note / photo" reply come in all 3 languages.
- AI prompt now tells the AI which language and script to reply in.

## 3. Answers without an AI key (or when AI is down)

The bot now answers from **Business info → Training data**:

```
Timings: 10 AM – 8 PM, Monday to Saturday
Delivery charges: ₹50, free above ₹999

Q: Delivery kitne din me hoti hai?
A: Shahar me same day, baaki jagah 2–3 din.
```

It understands the same question in different words/languages
("kab khulta hai" = "what time do you open" = "दुकान का समय"),
plus the address / phone / website from Business info and product names from Products (price + stock).
Shown as "Training data" in chats and in the Test tab.

## 4. Bug fixes

- **Messages were dropped**: if a customer wrote again while the bot was still replying (AI + typing ≈ 5–20 s),
  that message never got an answer. Now it is answered right after.
- **Security**: without SESSION_SECRET the app used a public development key — anyone could forge a login
  (even Super Admin). Now blocked on live servers.
- "ok thanks", "thank you so much sir", "theek hai ji" no longer get a fallback reply.
- Voice notes / photos without text: polite "please type" reply (once per hour) + chat marked "needs you",
  stickers ignored.
- Hindi STOP/START words: `band karo`, `बंद करो`, `chalu karo`, `चालू करो` …
- Anthropic request had no timeout (could hang a reply forever).
- Bot test endpoint: history size capped (each test costs AI money); flow toggle body validated.
- Bot settings page now shows an error when saving fails.
- Frontend: removed unused duplicate files in the root (`api.ts`, `ui.tsx`, `page.tsx`, `tsconfig.tsbuildinfo`).
