"use strict";

const { assertCity, assertResolvedLocation } = require("./contracts");

function locationInputError() {
  const error = new Error("Invalid location input");
  error.code = "INVALID_LOCATION_INPUT";
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
        coordinates.longitude < -180 ||
        coordinates.longitude > 180 ||
        typeof coordinates.latitude !== "number" ||
        !Number.isFinite(coordinates.latitude) ||
        coordinates.latitude < -90 ||
        coordinates.latitude > 90
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
