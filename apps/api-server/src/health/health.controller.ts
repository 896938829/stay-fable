import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@stay-fable/api-contracts/health";

import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  live(): HealthResponse {
    return this.healthService.live();
  }

  @Get("ready")
  ready(): Promise<HealthResponse> {
    return this.healthService.ready();
  }
}
