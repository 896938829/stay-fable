import { ApiProperty } from "@nestjs/swagger";

export class CityResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class CitiesEnvelopeDto {
  @ApiProperty({ type: CityResponseDto, isArray: true })
  data!: CityResponseDto[];

  @ApiProperty()
  request_id!: string;
}

export class ResolvedLocationResponseDto {
  @ApiProperty({ type: CityResponseDto })
  city!: CityResponseDto;

  @ApiProperty({ type: "integer", minimum: 0 })
  distance_meters!: number;
}

export class ResolvedLocationEnvelopeDto {
  @ApiProperty({ type: ResolvedLocationResponseDto })
  data!: ResolvedLocationResponseDto;

  @ApiProperty()
  request_id!: string;
}
