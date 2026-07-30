import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { City, ResolvedLocation } from "@stay-fable/api-contracts/location";

import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { CitiesEnvelopeDto, ResolvedLocationEnvelopeDto } from "./dto/location-response.dto.js";
import { ResolveLocationDto } from "./dto/resolve-location.dto.js";
import { LocationService } from "./location.service.js";

const resolveLocationRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["longitude", "latitude"],
  properties: {
    longitude: { type: "number" as const, minimum: -180, maximum: 180 },
    latitude: { type: "number" as const, minimum: -90, maximum: 90 },
  },
};

@ApiTags("location")
@ApiBearerAuth("session")
@Controller()
@UseGuards(SessionAuthGuard)
export class LocationController {
  constructor(private readonly location: LocationService) {}

  @Get("cities")
  @ApiOperation({ summary: "List operating cities" })
  @ApiOkResponse({ description: "Operating cities", type: CitiesEnvelopeDto })
  listCities(): Promise<City[]> {
    return this.location.listCities();
  }

  @Post("location/resolve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resolve coordinates to the nearest operating city" })
  @ApiBody({ schema: resolveLocationRequestSchema })
  @ApiOkResponse({ description: "Resolved operating city", type: ResolvedLocationEnvelopeDto })
  resolve(@Body() body: ResolveLocationDto): Promise<ResolvedLocation> {
    return this.location.resolve(body);
  }
}
