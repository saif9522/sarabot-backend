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

  /** One request to one Gemini model. */
  private geminiCall(model: string, system: string, prompt: string, maxTokens: number, thinkingOff: boolean) {
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.settings.get('GEMINI_API_KEY'), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
          // Newer models "think" first and that counts against the output limit; leave room.
          maxOutputTokens: maxTokens + 2048,
          // Flash models can usually skip thinking: faster, cheaper replies. Retried without it if a model refuses.
          ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
  }

  /**
   * Gemini with retries: busy/overloaded answers (429, 500, 503, timeouts) are retried with a short wait,
   * then the backup model(s) in LLM_FALLBACK_MODEL (comma separated) are tried.
   */
  private async gemini(system: string, prompt: string, maxTokens: number): Promise<string> {
    const main = this.settings.get('LLM_MODEL', 'gemini-3.8-flash').trim();
    const backups = (process.env.LLM_FALLBACK_MODEL || '').split(',').map((m) => m.trim()).filter((m) => m && m !== main);
    const models = [main, ...backups];
    const busy = (status: number) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastError = 'Gemini request failed';

    for (const [mi, model] of models.entries()) {
      let thinkingOff = /flash/i.test(model);
      // Main model: up to 3 tries (waits 1.5s, 4s). Backups: 2 tries.
      const tries = mi === 0 ? 3 : 2;
      for (let attempt = 1; attempt <= tries; attempt++) {
        let res: Response;
        try {
          res = await this.geminiCall(model, system, prompt, maxTokens, thinkingOff);
        } catch (e) {
          lastError = `Gemini did not answer in time (${(e as Error).name})`;
          this.log.warn(`${lastError} — model ${model}, try ${attempt}/${tries}`);
          if (attempt < tries) await sleep(attempt === 1 ? 1500 : 4000);
          continue;
        }
        if (res.status === 400 && thinkingOff) {
          const body = await res.clone().text();
          if (/thinking/i.test(body)) { thinkingOff = false; attempt--; continue; } // model doesn't accept thinkingBudget: 0
        }
        if (res.ok) {
          const data: any = await res.json();
          const cand = data.candidates?.[0];
          const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
          if (!text) throw new Error(`Gemini returned no text (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
          if (mi > 0 || attempt > 1) this.log.log(`Gemini answered with ${model} on try ${attempt}`);
          return text;
        }
        const body = await res.text();
        if (busy(res.status)) {
          lastError = `Gemini is busy (${res.status})`;
          this.log.warn(`Gemini ${res.status} (model ${model}), try ${attempt}/${tries}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
          if (attempt < tries) await sleep(attempt === 1 ? 1500 : 4000);
          continue;
        }
        // Not a temporary problem: wrong key, unknown model, bad request.
        this.log.error(`Gemini ${res.status} (model ${model}): ${body.slice(0, 300)}`);
        if (res.status === 404 && mi < models.length - 1) { lastError = `Gemini model "${model}" is not available`; break; } // try the backup
        throw new Error(
          res.status === 404 ? `Gemini model "${model}" is not available — set LLM_MODEL to a current model`
          : res.status === 400 || res.status === 403 ? 'Gemini rejected the request — check the Gemini API key and model in Platform settings'
          : `Gemini request failed (${res.status})`,
        );
      }
    }
    throw new Error(`${lastError} — tried ${models.join(', ')}`);
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
