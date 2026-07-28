import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  City,
  ResolvedLocation,
  ResolveLocationRequest,
} from "@stay-fable/api-contracts/location";

import { BusinessException } from "../common/http/business.exception.js";
import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

interface NearestCityRow {
  id: string;
  code: string;
  name: string;
  distance_meters: number;
}

const cityNotSupported = (): BusinessException =>
  new BusinessException(HttpStatus.UNPROCESSABLE_ENTITY, "CITY_NOT_SUPPORTED", "当前城市暂未开通");

@Injectable()
export class LocationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async listCities(): Promise<City[]> {
    const cities = await this.database.city.findMany({
      where: { enabled: true },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      select: { id: true, code: true, nameZh: true },
    });

    return cities.map(({ id, code, nameZh }) => ({ id, code, name: nameZh }));
  }

  async resolve({ longitude, latitude }: ResolveLocationRequest): Promise<ResolvedLocation> {
    const rows = await this.database.$queryRaw<NearestCityRow[]>(
      Prisma.sql`
        WITH "input_location" AS (
          SELECT ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography AS "point"
        )
        SELECT
          "city"."id"::text AS "id",
          "city"."code",
          "city"."name_zh" AS "name",
          ROUND(
            ST_Distance("city"."center", "input_location"."point", false)
          )::int AS "distance_meters"
        FROM "city"
        CROSS JOIN "input_location"
        WHERE "city"."enabled" = true
        ORDER BY
          "city"."center" <-> "input_location"."point",
          "city"."display_order" ASC,
          "city"."id" ASC
        LIMIT 1
      `,
    );
    const nearest = rows[0];
    const maximumDistance = this.config.getOrThrow<number>("LOCATION_MAX_DISTANCE_METERS");

    if (nearest === undefined || nearest.distance_meters > maximumDistance) {
      throw cityNotSupported();
    }

    return {
      city: {
        id: nearest.id,
        code: nearest.code,
        name: nearest.name,
      },
      distance_meters: nearest.distance_meters,
    };
  }
}
