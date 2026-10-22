import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { LlmService } from '../llm.service';
import { BUILD } from '../version';

/** Public "are you alive?" check. Used by the keep-alive ping and uptime monitors. Reveals nothing private. */
@Controller('health')
export class HealthController {
  constructor(private llm: LlmService) {}

  @Public()
  @Get()
  ok() {
    // ai = which AI provider has a key (never the key itself)
    return { ok: true, build: BUILD, ai: this.llm.provider ?? 'none', time: new Date().toISOString() };
  }
}
