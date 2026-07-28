import { RequestMethod } from "@nestjs/common";

export const LOGGER_ROUTES = [{ path: "{*path}", method: RequestMethod.ALL }];
