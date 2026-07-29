"use strict";

const assert = require("node:assert/strict");
const { lstat, mkdir, realpath, writeFile } = require("node:fs/promises");
const path = require("node:path");
const automator = require("miniprogram-automator");

const HOME_SELECTOR = ".home";
const SEARCH_ACTION_SELECTOR = ".search-button";
const PROPERTY_LIST_SELECTOR = ".property-list-page";
const PROPERTY_RESULTS_SELECTOR = ".property-results";
const FILTER_SELECTOR = ".filter";
const PROPERTY_CARD_SELECTOR = "property-card";
const PROPERTY_CARD_ACTION_SELECTOR = ".property-card__tap-target";
const PROPERTY_DETAIL_SELECTOR = ".property-detail-page";
const ROOM_ACTION_SELECTOR = ".room-card__action";
const ROOM_DETAIL_SELECTOR = ".room-detail-page";
const NIGHTLY_PRICE_SELECTOR = ".nightly-list__item";
const BOOKING_HINT_SELECTOR = ".detail-section__hint";
const ROOM_SELECTION_SELECTOR = ".selection-bar__action";
const HOMESTAY_TYPE = "HOMESTAY";
const ACTION_TIMEOUT_MS = 10_000;
const WORKFLOW_TIMEOUT_MS = 120_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATALOG_SEARCH_FIXTURE = Object.freeze({
  city: Object.freeze({
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    name: "杭州",
  }),
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 3,
});
const FAILURE_STEPS = new Set([
  "arguments",
  "launch",
  "fixture",
  "home",
  "property-list",
  "homestay-filter",
  "restore-all",
  "property-detail",
  "room-detail",
  "booking-notice",
  "return-to-list",
  "workflow",
  "cleanup",
]);
const SAFE_PAGE_ROUTE_PATTERN =
  /^pages\/[a-z0-9-]+\/[a-z0-9-]+$/;
const UNSAFE_EVIDENCE_MARKERS = [
  ["access", "token"].join("_"),
  ["refresh", "token"].join("_"),
  ["author", "ization"].join(""),
  ["bear", "er"].join(""),
  ["app", "id"].join(""),
  ["long", "itude"].join(""),
  ["lat", "itude"].join(""),
];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function withTimeout(label, task, timeoutMs = ACTION_TIMEOUT_MS) {
  let timer;
  const operation = Promise.resolve().then(task);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function invalidArguments() {
  return new Error("catalog automator arguments are invalid");
}

function parseCliArguments(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    ![2, 4].includes(arguments_.length) ||
    arguments_.some(
      (argument) => typeof argument !== "string" || argument === "",
    ) ||
    (arguments_.length === 4 && arguments_[2] !== "--cli-path")
  ) {
    throw invalidArguments();
  }
  return {
    projectPath: arguments_[0],
    evidenceDirectory: arguments_[1],
    cliPath: arguments_.length === 4 ? arguments_[3] : undefined,
  };
}

function absolutePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    (path.win32.isAbsolute(value) || path.posix.isAbsolute(value))
  );
}

function controlledCliPath(environment) {
  try {
    return environment &&
      typeof environment === "object" &&
      typeof environment.WECHAT_DEVTOOLS_CLI_PATH === "string"
      ? environment.WECHAT_DEVTOOLS_CLI_PATH
      : undefined;
  } catch {
    return undefined;
  }
}

function buildLaunchOptions(projectPath, explicitCliPath, environment = {}) {
  const cliPath =
    explicitCliPath === undefined
      ? controlledCliPath(environment)
      : explicitCliPath;
  if (!absolutePath(projectPath) || !absolutePath(cliPath)) {
    throw new Error("WeChat DevTools CLI path is required");
  }
  return { cliPath, projectPath };
}

function launchMiniProgram(
  automatorApi,
  options,
  timeoutMs = ACTION_TIMEOUT_MS * 3,
) {
  return withTimeout(
    "launch mini-program",
    () => automatorApi.launch(options),
    timeoutMs,
  );
}

function createStepTracker() {
  let step = "launch";
  return {
    enter(nextStep) {
      step = FAILURE_STEPS.has(nextStep) ? nextStep : "workflow";
    },
    get step() {
      return step;
    },
  };
}

function safePageRoute(value) {
  try {
    const route =
      typeof value === "string" ? value.replace(/^\/+/, "") : "";
    return SAFE_PAGE_ROUTE_PATTERN.test(route) ? route : "unknown";
  } catch {
    return "unknown";
  }
}

function catalogFailure(step, currentPage, evidencePaths) {
  const error = new Error("catalog automation failed");
  error.step = FAILURE_STEPS.has(step) ? step : "workflow";
  error.currentPage = safePageRoute(currentPage);
  error.evidencePaths = Array.isArray(evidencePaths)
    ? [...evidencePaths]
    : [];
  return error;
}

async function prepareCatalogHome(miniprogram) {
  const fixture = await withTimeout("establish catalog fixture", () =>
    miniprogram.evaluate((value) => {
      const stored = getApp().globalData.searchStore.set(value);
      return {
        city: {
          id: stored.city.id,
          code: stored.city.code,
          name: stored.city.name,
        },
        checkin: stored.checkin,
        checkout: stored.checkout,
        guests: stored.guests,
      };
    }, CATALOG_SEARCH_FIXTURE),
  );
  assert.deepEqual(fixture, CATALOG_SEARCH_FIXTURE);
  await withTimeout("open home", () =>
    miniprogram.reLaunch("/pages/home/home"),
  );
}

async function requireElement(container, selector) {
  const element = await withTimeout(`wait for ${selector}`, async () => {
    if (typeof container.waitFor === "function") {
      await container.waitFor(selector);
    }
    return container.$(selector);
  });
  assert.ok(element, `required element missing: ${selector}`);
  return element;
}

async function waitForPage(miniprogram, expectedPath, rootSelector) {
  const page = await withTimeout(`open ${expectedPath}`, async () => {
    const current = await miniprogram.currentPage();
    assert.ok(current, `page missing: ${expectedPath}`);
    await current.waitFor(rootSelector);
    return current;
  });
  assert.equal(page.path.replace(/^\/+/, ""), expectedPath);
  return { data: await page.data(), page };
}

async function waitForData(page, predicate, label) {
  await withTimeout(label, () =>
    page.waitFor(async () => predicate(await page.data())),
  );
  return page.data();
}

async function ensureAbsent(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`evidence artifact already exists: ${path.basename(filePath)}`);
}

function assertSafeEvidence(source) {
  const normalized = String(source).toLowerCase();
  for (const marker of UNSAFE_EVIDENCE_MARKERS) {
    assert.equal(
      normalized.includes(marker),
      false,
      "sensitive marker found in page evidence",
    );
  }
}

function relativeEvidencePath(evidenceRoot, filePath) {
  const relative = path.relative(evidenceRoot, filePath);
  assert.equal(isWithin(evidenceRoot, filePath), true);
  return relative.split(path.sep).join("/");
}

async function writeTree(evidenceRoot, name, source, evidencePaths) {
  assertSafeEvidence(source);
  const filePath = path.join(evidenceRoot, `${name}.tree.wxml`);
  await ensureAbsent(filePath);
  await writeFile(filePath, source, { encoding: "utf8", flag: "wx" });
  evidencePaths.push(relativeEvidencePath(evidenceRoot, filePath));
}

async function capturePage(
  miniprogram,
  page,
  rootSelector,
  evidenceRoot,
  name,
  evidencePaths,
) {
  const root = await requireElement(page, rootSelector);
  const tree = await withTimeout(`${name} page tree`, () => root.outerWxml());
  await writeTree(evidenceRoot, name, tree, evidencePaths);

  const screenshotPath = path.join(evidenceRoot, `${name}.png`);
  await ensureAbsent(screenshotPath);
  await withTimeout(`${name} screenshot`, () =>
    miniprogram.screenshot({ path: screenshotPath }),
  );
  evidencePaths.push(relativeEvidencePath(evidenceRoot, screenshotPath));
}

async function captureComponent(
  component,
  evidenceRoot,
  name,
  evidencePaths,
) {
  const tree = await withTimeout(`${name} component tree`, () =>
    component.wxml(),
  );
  await writeTree(evidenceRoot, name, tree, evidencePaths);
}

async function filterElement(page, type) {
  const filters = await withTimeout("catalog filters", () =>
    page.$$(FILTER_SELECTOR),
  );
  for (const filter of filters) {
    if ((await filter.attribute("data-type")) === type) {
      return filter;
    }
  }
  return null;
}

function safeSearchSnapshot(search) {
  assert.ok(search && typeof search === "object");
  assert.ok(search.city && typeof search.city === "object");
  const snapshot = {
    city: {
      id: search.city.id,
      code: search.city.code,
      name: search.city.name,
    },
    checkin: search.checkin,
    checkout: search.checkout,
    guests: search.guests,
  };
  assert.match(snapshot.checkin, DATE_PATTERN);
  assert.match(snapshot.checkout, DATE_PATTERN);
  assert.deepEqual(snapshot, CATALOG_SEARCH_FIXTURE);
  return {
    cityId: snapshot.city.id,
    cityCode: search.city.code,
    cityName: search.city.name,
    checkin: search.checkin,
    checkout: search.checkout,
    guests: search.guests,
  };
}

function assertPropertyOnlyItems(items) {
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const item of items) {
    assert.ok(item && typeof item === "object");
    assert.equal(typeof item.id, "string");
    for (const forbidden of [
      "room_types",
      "roomTypes",
      "nightly_prices",
      "nightlyPrices",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, forbidden), false);
    }
  }
}

async function catalogWorkflow(
  miniprogram,
  evidenceRoot,
  evidencePaths,
  stepTracker,
) {
  stepTracker.enter("fixture");
  await prepareCatalogHome(miniprogram);
  stepTracker.enter("home");
  let current = await waitForPage(
    miniprogram,
    "pages/home/home",
    HOME_SELECTOR,
  );
  assert.equal(current.data.status, "ready");
  const expectedSearch = safeSearchSnapshot(current.data.search);
  await capturePage(
    miniprogram,
    current.page,
    HOME_SELECTOR,
    evidenceRoot,
    "01-home-ready",
    evidencePaths,
  );

  const searchAction = await requireElement(
    current.page,
    SEARCH_ACTION_SELECTOR,
  );
  await withTimeout("search properties", () => searchAction.tap());
  stepTracker.enter("property-list");
  current = await waitForPage(
    miniprogram,
    "pages/property-list/property-list",
    PROPERTY_LIST_SELECTOR,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "list",
    "property list data",
  );
  assertPropertyOnlyItems(current.data.items);
  assert.equal(await current.page.$(".room-card"), null);
  await requireElement(current.page, PROPERTY_RESULTS_SELECTOR);
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "02-property-list-all",
    evidencePaths,
  );

  const homestay = await filterElement(current.page, HOMESTAY_TYPE);
  assert.ok(homestay, "HOMESTAY filter missing");
  stepTracker.enter("homestay-filter");
  await withTimeout("select HOMESTAY", () => homestay.tap());
  current.data = await waitForData(
    current.page,
    (data) => data.activeType === HOMESTAY_TYPE && data.status === "list",
    "HOMESTAY results",
  );
  assertPropertyOnlyItems(current.data.items);
  assert.ok(current.data.items.every((item) => item.type === HOMESTAY_TYPE));
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "03-property-list-homestay",
    evidencePaths,
  );

  const all = await filterElement(current.page, "");
  assert.ok(all, "all-properties filter missing");
  stepTracker.enter("restore-all");
  await withTimeout("restore all properties", () => all.tap());
  current.data = await waitForData(
    current.page,
    (data) => data.activeType === "" && data.status === "list",
    "restored property results",
  );
  assertPropertyOnlyItems(current.data.items);

  const propertyCards = await withTimeout("property cards", () =>
    current.page.$$(PROPERTY_CARD_SELECTOR),
  );
  assert.ok(propertyCards.length > 0, "property card missing");
  const propertyCard = propertyCards[0];
  await captureComponent(
    propertyCard,
    evidenceRoot,
    "04-first-property-card",
    evidencePaths,
  );
  const propertyAction = await withTimeout("property card action", () =>
    propertyCard.$(PROPERTY_CARD_ACTION_SELECTOR),
  );
  assert.ok(propertyAction, "property card action missing");
  await withTimeout("open property", () => propertyAction.tap());

  stepTracker.enter("property-detail");
  current = await waitForPage(
    miniprogram,
    "pages/property-detail/property-detail",
    PROPERTY_DETAIL_SELECTOR,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "success" && data.property !== null,
    "property detail data",
  );
  assert.ok(current.data.property.roomTypes.length > 0);
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_DETAIL_SELECTOR,
    evidenceRoot,
    "05-property-detail",
    evidencePaths,
  );

  const roomAction = await requireElement(current.page, ROOM_ACTION_SELECTOR);
  await withTimeout("open room", () => roomAction.tap());
  stepTracker.enter("room-detail");
  current = await waitForPage(
    miniprogram,
    "pages/room-detail/room-detail",
    ROOM_DETAIL_SELECTOR,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "success" && data.roomType !== null,
    "room detail data",
  );
  assert.ok(current.data.roomType.nightlyPrices.length > 0);
  const nightlyRows = await withTimeout("nightly price rows", () =>
    current.page.$$(NIGHTLY_PRICE_SELECTOR),
  );
  assert.equal(
    nightlyRows.length,
    current.data.roomType.nightlyPrices.length,
  );
  const bookingHint = await requireElement(current.page, BOOKING_HINT_SELECTOR);
  assert.match(await bookingHint.text(), /下一切片/);
  await capturePage(
    miniprogram,
    current.page,
    ROOM_DETAIL_SELECTOR,
    evidenceRoot,
    "06-room-detail",
    evidencePaths,
  );

  const roomSelection = await requireElement(
    current.page,
    ROOM_SELECTION_SELECTOR,
  );
  stepTracker.enter("booking-notice");
  await withTimeout("show booking notice", () => roomSelection.tap());
  await capturePage(
    miniprogram,
    current.page,
    ROOM_DETAIL_SELECTOR,
    evidenceRoot,
    "07-booking-notice",
    evidencePaths,
  );
  await withTimeout("close booking notice", () =>
    miniprogram.native().confirmModal(),
  );

  stepTracker.enter("return-to-list");
  await withTimeout("return to property", () => miniprogram.navigateBack());
  await waitForPage(
    miniprogram,
    "pages/property-detail/property-detail",
    PROPERTY_DETAIL_SELECTOR,
  );
  await withTimeout("return to list", () => miniprogram.navigateBack());
  current = await waitForPage(
    miniprogram,
    "pages/property-list/property-list",
    PROPERTY_LIST_SELECTOR,
  );
  const restoredSearch = await withTimeout("read restored search", () =>
    miniprogram.evaluate(() => {
      const search = getApp().globalData.searchStore.get();
      return {
        cityId: search.city.id,
        cityCode: search.city.code,
        cityName: search.city.name,
        checkin: search.checkin,
        checkout: search.checkout,
        guests: search.guests,
      };
    }),
  );
  assert.deepEqual(restoredSearch, expectedSearch);
  assert.equal(current.data.searchSummary.cityLabel, expectedSearch.cityName);
  assert.equal(current.data.searchSummary.guestsLabel, "3人");
  assert.equal(
    current.data.searchSummary.dateLabel,
    `${expectedSearch.checkin} 至 ${expectedSearch.checkout}`,
  );
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "08-returned-property-list",
    evidencePaths,
  );

  return {
    city: expectedSearch.cityName,
    checkin: expectedSearch.checkin,
    checkout: expectedSearch.checkout,
    guests: expectedSearch.guests,
    propertyCount: current.data.items.length,
    evidencePaths,
  };
}

async function run(
  projectPath,
  evidenceDirectory,
  cliPath,
  dependencies = {},
) {
  assert.ok(path.isAbsolute(projectPath || ""), "absolute projectPath is required");
  assert.ok(evidenceDirectory, "evidenceDirectory is required");
  const projectRoot = await realpath(projectPath);
  const requestedEvidenceRoot = path.resolve(evidenceDirectory);
  assert.equal(
    isWithin(projectRoot, requestedEvidenceRoot),
    false,
    "evidenceDirectory must be outside the mini-program project",
  );
  await mkdir(requestedEvidenceRoot, { recursive: true });
  const evidenceRoot = await realpath(requestedEvidenceRoot);
  assert.equal(
    isWithin(projectRoot, evidenceRoot),
    false,
    "evidenceDirectory must be outside the mini-program project",
  );

  const evidencePaths = [];
  const stepTracker = createStepTracker();
  let launchOptions;
  try {
    launchOptions = buildLaunchOptions(
      projectRoot,
      cliPath,
      dependencies.environment || process.env,
    );
  } catch {
    throw catalogFailure("launch", "unknown", evidencePaths);
  }
  let miniprogram;
  try {
    miniprogram = await launchMiniProgram(
      dependencies.automatorApi || automator,
      launchOptions,
    );
  } catch {
    throw catalogFailure("launch", "unknown", evidencePaths);
  }
  let result;
  let failure = null;
  let currentPage = "unknown";
  try {
    result = await withTimeout(
      "catalog workflow",
      () =>
        catalogWorkflow(
          miniprogram,
          evidenceRoot,
          evidencePaths,
          stepTracker,
        ),
      WORKFLOW_TIMEOUT_MS,
    );
  } catch {
    try {
      await withTimeout("failure evidence", async () => {
        const page = await miniprogram.currentPage();
        currentPage = safePageRoute(page && page.path);
        if (page) {
          const root =
            (await page.$(ROOM_DETAIL_SELECTOR)) ||
            (await page.$(PROPERTY_DETAIL_SELECTOR)) ||
            (await page.$(PROPERTY_LIST_SELECTOR)) ||
            (await page.$(HOME_SELECTOR));
          if (root) {
            await capturePage(
              miniprogram,
              page,
              `.${(await root.attribute("class")).split(/\s+/)[0]}`,
              evidenceRoot,
              "99-failure",
              evidencePaths,
            );
          }
        }
      });
    } catch {
      // A failed evidence capture must not mask the workflow failure.
    }
    failure = catalogFailure(
      stepTracker.step,
      currentPage,
      evidencePaths,
    );
  }
  try {
    await withTimeout("close mini-program", () => miniprogram.close());
  } catch {
    if (failure === null) {
      failure = catalogFailure("cleanup", currentPage, evidencePaths);
    }
  }
  if (failure !== null) {
    throw failure;
  }
  return result;
}

if (require.main === module) {
  let cliArguments;
  try {
    cliArguments = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "fail",
        message: error.message,
        step: "arguments",
        currentPage: "unknown",
        evidencePaths: [],
      }),
    );
    process.exitCode = 1;
  }
  const execution = cliArguments
    ? run(
        cliArguments.projectPath,
        cliArguments.evidenceDirectory,
        cliArguments.cliPath,
      )
    : Promise.resolve();
  execution
    .then((result) =>
      result
        ? console.log(JSON.stringify({ status: "pass", ...result }))
        : undefined,
    )
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: "fail",
          message: error.message,
          step: error.step || "workflow",
          currentPage: error.currentPage || "unknown",
          evidencePaths: error.evidencePaths || [],
        }),
      );
      process.exitCode = 1;
    });
}

module.exports = {
  CATALOG_SEARCH_FIXTURE,
  buildLaunchOptions,
  launchMiniProgram,
  parseCliArguments,
  prepareCatalogHome,
  run,
};
