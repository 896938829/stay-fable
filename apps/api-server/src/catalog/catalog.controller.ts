import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import type {
  PropertyDetail,
  PropertyListResponse,
  RoomTypeDetail,
} from "@stay-fable/api-contracts/catalog";

import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { CatalogService } from "./catalog.service.js";
import { AvailabilityQueryDto, PropertyListQueryDto } from "./dto/catalog-query.dto.js";
import {
  ApiErrorEnvelopeDto,
  PropertyDetailEnvelopeDto,
  PropertyListEnvelopeDto,
  RoomTypeDetailEnvelopeDto,
} from "./dto/catalog-response.dto.js";

@ApiTags("catalog")
@ApiBearerAuth("session")
@Controller()
@UseGuards(SessionAuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("properties")
  @ApiOperation({ summary: "List available properties" })
  @ApiOkResponse({ description: "Available properties", type: PropertyListEnvelopeDto })
  @ApiBadRequestResponse({ description: "Invalid catalog query", type: ApiErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ description: "Authentication required", type: ApiErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({
    description: "Catalog service temporarily unavailable",
    type: ApiErrorEnvelopeDto,
  })
  listProperties(@Query() query: PropertyListQueryDto): Promise<PropertyListResponse> {
    return this.catalog.listProperties(query);
  }

  @Get("properties/:propertyId")
  @ApiOperation({ summary: "Get an available property" })
  @ApiParam({ name: "propertyId", format: "uuid" })
  @ApiOkResponse({ description: "Available property", type: PropertyDetailEnvelopeDto })
  @ApiBadRequestResponse({ description: "Invalid availability query", type: ApiErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ description: "Authentication required", type: ApiErrorEnvelopeDto })
  @ApiNotFoundResponse({ description: "Property not available", type: ApiErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({
    description: "Catalog service temporarily unavailable",
    type: ApiErrorEnvelopeDto,
  })
  getProperty(
    @Param("propertyId", new ParseUUIDPipe({ version: "4" })) propertyId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<PropertyDetail> {
    return this.catalog.getProperty(propertyId, query);
  }

  @Get("room-types/:roomTypeId")
  @ApiOperation({ summary: "Get an available room type" })
  @ApiParam({ name: "roomTypeId", format: "uuid" })
  @ApiOkResponse({ description: "Available room type", type: RoomTypeDetailEnvelopeDto })
  @ApiBadRequestResponse({ description: "Invalid availability query", type: ApiErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ description: "Authentication required", type: ApiErrorEnvelopeDto })
  @ApiNotFoundResponse({ description: "Room type not available", type: ApiErrorEnvelopeDto })
  @ApiUnprocessableEntityResponse({
    description: "Guest capacity exceeded",
    type: ApiErrorEnvelopeDto,
  })
  @ApiServiceUnavailableResponse({
    description: "Catalog service temporarily unavailable",
    type: ApiErrorEnvelopeDto,
  })
  getRoomType(
    @Param("roomTypeId", new ParseUUIDPipe({ version: "4" })) roomTypeId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<RoomTypeDetail> {
    return this.catalog.getRoomType(roomTypeId, query);
  }
}
