import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';

/** Public "are you alive?" check. Used by the keep-alive ping and uptime monitors. Reveals nothing private. */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  ok() {
    return { ok: true, time: new Date().toISOString() };
  }
}
