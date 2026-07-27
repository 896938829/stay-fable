import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
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
  async ready(): Promise<HealthResponse> {
    const response = await this.healthService.ready();
    if (response.status === "unavailable") {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}
