import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length } from "class-validator";

export class WechatLoginDto {
  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @Length(8, 128)
  code!: string;
}
