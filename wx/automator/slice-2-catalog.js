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
  assert.equal(search.city.name, "杭州");
  assert.match(search.checkin, DATE_PATTERN);
  assert.match(search.checkout, DATE_PATTERN);
  assert.equal(search.guests, 3);
  return {
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

async function catalogWorkflow(miniprogram, evidenceRoot, evidencePaths) {
  await withTimeout("open home", () =>
    miniprogram.reLaunch("/pages/home/home"),
  );
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

async function run(projectPath, evidenceDirectory) {
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
  const miniprogram = await withTimeout(
    "launch mini-program",
    () => automator.launch({ projectPath: projectRoot }),
    ACTION_TIMEOUT_MS * 3,
  );
  let result;
  let failure = null;
  try {
    result = await withTimeout(
      "catalog workflow",
      () => catalogWorkflow(miniprogram, evidenceRoot, evidencePaths),
      WORKFLOW_TIMEOUT_MS,
    );
  } catch {
    try {
      await withTimeout("failure evidence", async () => {
        const page = await miniprogram.currentPage();
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
    failure = new Error("catalog automation failed");
    failure.evidencePaths = evidencePaths;
  }
  try {
    await withTimeout("close mini-program", () => miniprogram.close());
  } catch {
    if (failure === null) {
      failure = new Error("catalog automation cleanup failed");
      failure.evidencePaths = evidencePaths;
    }
  }
  if (failure !== null) {
    throw failure;
  }
  return result;
}

if (require.main === module) {
  run(process.argv[2], process.argv[3])
    .then((result) =>
      console.log(JSON.stringify({ status: "pass", ...result })),
    )
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: "fail",
          message: error.message,
          evidencePaths: error.evidencePaths || [],
        }),
      );
      process.exitCode = 1;
    });
}

module.exports = { run };
