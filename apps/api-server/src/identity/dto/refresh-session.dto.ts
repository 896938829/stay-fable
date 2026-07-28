import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class RefreshSessionDto {
  @ApiProperty({ minLength: 32 })
  @IsString()
  @MinLength(32)
  refresh_token!: string;
}
