import { Global, Injectable, Logger, Module } from '@nestjs/common';

type Provider = 'gemini' | 'anthropic' | null;

/**
 * AI client. Uses Google Gemini when GEMINI_API_KEY is set, otherwise Anthropic when
 * ANTHROPIC_API_KEY is set. Without either, bots use flows and the fallback message only.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger('AI');

  get provider(): Provider {
    if (process.env.GEMINI_API_KEY) return 'gemini';
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

  private async gemini(system: string, prompt: string, maxTokens: number): Promise<string> {
    const model = process.env.LLM_MODEL || 'gemini-2.5-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY || '', 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
          // 2.5 models "think" first and that counts against the output limit; leave room.
          maxOutputTokens: maxTokens + 2048,
          // Flash models can skip thinking entirely: faster, cheaper replies.
          ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      this.log.error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
      throw new Error(res.status === 400 || res.status === 403 ? 'Gemini rejected the request — check GEMINI_API_KEY and LLM_MODEL' : `Gemini request failed (${res.status})`);
    }
    const data: any = await res.json();
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p: any) => p.text || '').join('');
    if (!text) throw new Error(`Gemini returned no text (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
    return text;
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
