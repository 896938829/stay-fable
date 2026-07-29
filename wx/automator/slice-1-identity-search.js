"use strict";

const assert = require("node:assert/strict");
const automator = require("miniprogram-automator");

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

async function currentData(miniprogram, selector) {
  const page = await miniprogram.currentPage();
  await page.waitFor(selector);
  return { page, data: await page.data() };
}

async function run(projectPath, screenshotPath) {
  assert.ok(projectPath, "projectPath is required");
  const miniprogram = await automator.launch({ projectPath });

  try {
    let current = await currentData(miniprogram, ".home");
    assert.equal(current.data.status, "ready");
    assert.equal(current.data.search.city, null);
    assert.equal(current.data.search.guests, 2);
    assert.equal(current.data.search.checkout, addDays(current.data.search.checkin, 1));

    // The WeChat automation bridge cannot propagate callback or Promise rejection
    // mocks into wx.getLocation. Location-denial mapping remains covered by unit
    // tests; this executable path starts at the same manual-city fallback.
    await current.page.callMethod("openCitySelect");
    current = await currentData(miniprogram, ".city-item");
    assert.equal(current.data.status, "list");
    assert.deepEqual(
      current.data.cities.map(({ code, name }) => ({ code, name })),
      [
        { code: "330100", name: "杭州" },
        { code: "520100", name: "贵阳" },
      ],
    );
    await (await current.page.$(".city-item")).tap();

    current = await currentData(miniprogram, ".home");
    assert.equal(current.data.search.city.code, "330100");
    const checkin = addDays(current.data.search.checkin, 1);
    const checkout = addDays(checkin, 2);
    await current.page.callMethod("openDateGuestSelect");

    current = await currentData(miniprogram, ".date-page");
    await current.page.callMethod("changeCheckin", { detail: { value: checkin } });
    await current.page.callMethod("changeCheckout", { detail: { value: checkout } });
    await current.page.callMethod("incrementGuests");
    current.data = await current.page.data();
    assert.equal(current.data.checkin, checkin);
    assert.equal(current.data.checkout, checkout);
    assert.equal(current.data.guests, 3);
    await (await current.page.$(".save-button")).tap();

    current = await currentData(miniprogram, ".home");
    assert.equal(current.data.search.city.code, "330100");
    assert.equal(current.data.search.checkin, checkin);
    assert.equal(current.data.search.checkout, checkout);
    assert.equal(current.data.search.guests, 3);
    assert.equal(current.data.nightsLabel, "2晚");

    const beforeRecovery = await miniprogram.evaluate(() => {
      const session = getApp().globalData.sessionStore.get();
      const userId = session.user.id;
      session.access_token = "";
      return { userId, accessLength: session.access_token.length };
    });
    assert.equal(beforeRecovery.accessLength, 0);
    await current.page.callMethod("openCitySelect");

    current = await currentData(miniprogram, ".city-item");
    assert.equal(current.data.status, "list");
    const afterRecovery = await miniprogram.evaluate(() => {
      const session = getApp().globalData.sessionStore.get();
      return {
        userId: session.user.id,
        accessLength: session.access_token.length,
        refreshLength: session.refresh_token.length,
      };
    });
    assert.equal(afterRecovery.userId, beforeRecovery.userId);
    assert.ok(afterRecovery.accessLength >= 32);
    assert.ok(afterRecovery.refreshLength >= 32);

    await miniprogram.navigateBack();
    current = await currentData(miniprogram, ".home");
    if (screenshotPath) {
      await miniprogram.screenshot({ path: screenshotPath });
    }
    return {
      city: current.data.search.city.name,
      checkin: current.data.search.checkin,
      checkout: current.data.search.checkout,
      guests: current.data.search.guests,
      refreshRecovered: true,
    };
  } finally {
    await miniprogram.close();
  }
}

if (require.main === module) {
  run(process.argv[2], process.argv[3])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { run };
