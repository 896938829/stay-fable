"use strict";

const { assertCity, assertResolvedLocation } = require("./contracts");

function locationInputError() {
  const error = new Error("Invalid location coordinates");
  error.code = "INVALID_LOCATION_COORDINATES";
  return error;
}

function invalidResponse() {
  const error = new Error("Invalid API response");
  error.code = "INVALID_API_RESPONSE";
  return error;
}

function createLocationService(requestClient) {
  return {
    async listCities() {
      const data = await requestClient.get("/cities");
      if (!Array.isArray(data)) {
        throw invalidResponse();
      }
      data.forEach(assertCity);
      return data;
    },
    async resolve(coordinates) {
      if (
        !coordinates ||
        typeof coordinates.longitude !== "number" ||
        !Number.isFinite(coordinates.longitude) ||
        typeof coordinates.latitude !== "number" ||
        !Number.isFinite(coordinates.latitude)
      ) {
        throw locationInputError();
      }
      const data = await requestClient.post("/location/resolve", {
        longitude: coordinates.longitude,
        latitude: coordinates.latitude,
      });
      return assertResolvedLocation(data);
    },
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createLocationService(require("./request"));
  }
  return defaultService;
}

module.exports = {
  createLocationService,
  listCities() {
    return getDefaultService().listCities();
  },
  resolve(coordinates) {
    return getDefaultService().resolve(coordinates);
  },
};
