import { ApiProperty } from "@nestjs/swagger";

export class AuthSessionUserDto {
  @ApiProperty({ format: "uuid" })
  id!: string;
}

export class AuthSessionResponseDto {
  @ApiProperty({ minLength: 32 })
  access_token!: string;

  @ApiProperty({ minimum: 1, type: Number })
  access_expires_in!: number;

  @ApiProperty({ minLength: 32 })
  refresh_token!: string;

  @ApiProperty({ minimum: 1, type: Number })
  refresh_expires_in!: number;

  @ApiProperty({ type: AuthSessionUserDto })
  user!: AuthSessionUserDto;
}

export class AuthSessionEnvelopeDto {
  @ApiProperty({ type: AuthSessionResponseDto })
  data!: AuthSessionResponseDto;

  @ApiProperty()
  request_id!: string;
}
