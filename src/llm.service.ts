import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { SettingsService } from './settings/settings.service';

type Provider = 'gemini' | 'anthropic' | null;

/**
 * AI client. Uses Google Gemini when GEMINI_API_KEY is set, otherwise Anthropic when
 * ANTHROPIC_API_KEY is set. Without either, bots use flows and the fallback message only.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger('AI');
  constructor(private settings: SettingsService) {}

  get provider(): Provider {
    if (this.settings.get('GEMINI_API_KEY')) return 'gemini';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    return null;
  }

  get enabled() {
    return this.provider !== null;
  }

  async json<T>(system: string, prompt: string, maxTokens = 1024): Promise<T> {
    const text = this.provider === 'gemini' ? await this.gemini(system, prompt, maxTokens) : await this.anthropic(system, prompt, maxTokens);
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AI did not return JSON');
    return JSON.parse(clean.slice(start, end + 1));
  }

  /**
   * How much each model accepts, learnt at runtime:
   * 0 = thinking off + JSON mode, 1 = JSON mode only, 2 = plain request (JSON parsed from the text).
   */
  private compat = new Map<string, number>();
  /** Models that answered 404 / unusable 400, skipped for a while. */
  private skipUntil = new Map<string, number>();

  /** One request to one Gemini model. */
  private geminiCall(model: string, system: string, prompt: string, maxTokens: number, level: number) {
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.settings.get('GEMINI_API_KEY'), 'content-type': 'application/json' },
      // Customers are waiting on WhatsApp: don't hang on a slow model, try the next one.
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          ...(level < 2 ? { responseMimeType: 'application/json' } : {}),
          temperature: 0.4,
          // Newer models "think" first and that counts against the output limit; leave room.
          maxOutputTokens: maxTokens + 2048,
          ...(level === 0 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
  }

  /**
   * Gemini, built for speed and busy times:
   *  - round 1 tries every model once (main, then LLM_FALLBACK_MODEL in order) without waiting;
   *  - if all were busy, wait 2 s and do one more round;
   *  - a 400 is retried with simpler settings; 404s and unusable models are skipped for 10 minutes.
   */
  private async gemini(system: string, prompt: string, maxTokens: number): Promise<string> {
    const main = this.settings.get('LLM_MODEL', 'gemini-3.8-flash').trim();
    const backups = (this.settings.get('LLM_FALLBACK_MODEL') || process.env.LLM_FALLBACK_MODEL || '')
      .split(',').map((m) => m.trim()).filter((m, i, all) => m && m !== main && all.indexOf(m) === i);
    const busy = (status: number) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    let lastError = 'Gemini request failed';
    let keyProblem = false;

    for (let round = 1; round <= 2; round++) {
      const models = [main, ...backups].filter((m) => (this.skipUntil.get(m) ?? 0) < Date.now());
      if (!models.length) break;
      let anyBusy = false;
      for (const model of models) {
        let level = this.compat.get(model) ?? (/flash/i.test(model) ? 0 : 1);
        while (level <= 2) {
          let res: Response;
          try {
            res = await this.geminiCall(model, system, prompt, maxTokens, level);
          } catch (e) {
            anyBusy = true;
            lastError = `Gemini did not answer in time (${(e as Error).name})`;
            this.log.warn(`${lastError} — model ${model}, round ${round}`);
            break;
          }
          if (res.ok) {
            const data: any = await res.json();
            const cand = data.candidates?.[0];
            const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
            if (!text) { lastError = `Gemini returned no text (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`; break; }
            this.compat.set(model, level);
            if (model !== main || round > 1) this.log.log(`Gemini answered with ${model} (round ${round}, ${Math.round((Date.now() - started) / 100) / 10}s)`);
            return text;
          }
          const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
          if (busy(res.status)) {
            anyBusy = true;
            lastError = `Gemini is busy (${res.status})`;
            this.log.warn(`Gemini ${res.status} (model ${model}), round ${round}: ${body.slice(0, 120)}`);
            break;
          }
          if (res.status === 400 && level < 2) {
            this.log.warn(`Gemini 400 (model ${model}) with settings level ${level}, retrying with simpler settings: ${body.slice(0, 120)}`);
            level++;
            continue;
          }
          // Not temporary for this model.
          this.log.error(`Gemini ${res.status} (model ${model}): ${body}`);
          if (res.status === 401 || res.status === 403 || /API key/i.test(body)) keyProblem = true;
          lastError = res.status === 404 ? `Gemini model "${model}" is not available` : `Gemini rejected the request (${res.status}) for ${model}`;
          this.skipUntil.set(model, Date.now() + 10 * 60_000);
          break;
        }
      }
      if (!anyBusy) break; // nothing temporary left to retry
      if (round === 1) await sleep(2000);
    }
    if (keyProblem) throw new Error('Gemini rejected the request — check the Gemini API key in Render or Platform settings');
    throw new Error(`${lastError} — tried ${[main, ...backups].join(', ')} in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  private async anthropic(system: string, prompt: string, maxTokens: number): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'claude-sonnet-5-5',
        max_tokens: maxTokens,
        system: `${system}\n\nRespond with a single JSON object only. No prose, no Markdown fences.`,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      this.log.error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      throw new Error(`AI request failed (${res.status})`);
    }
    const data: any = await res.json();
    return (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }
}

@Global()
@Module({ providers: [LlmService], exports: [LlmService] })
export class LlmModule {}
