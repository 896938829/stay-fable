import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const rootPackageUrl = new URL("../../package.json", import.meta.url);
const catalogAutomator = require("../automator/slice-2-catalog.js");
const temporaryDirectories = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("catalog automator dependency", () => {
  it("pins and loads the official automator used by the executable script", async () => {
    const rootPackage = JSON.parse(await readFile(rootPackageUrl, "utf8"));

    expect(rootPackage.devDependencies["miniprogram-automator"]).toBe("0.12.1");
    expect(() => require("miniprogram-automator")).not.toThrow();
    expect(() => require("../automator/slice-2-catalog.js")).not.toThrow();
  });
});

describe("catalog automator launch configuration", () => {
  it("parses only the two positional paths and an optional explicit CLI path", () => {
    expect(
      catalogAutomator.parseCliArguments([
        "C:\\workspace\\wx",
        "C:\\evidence\\catalog",
        "--cli-path",
        "C:\\tools\\wechat\\cli.bat",
      ]),
    ).toEqual({
      cliPath: "C:\\tools\\wechat\\cli.bat",
      evidenceDirectory: "C:\\evidence\\catalog",
      projectPath: "C:\\workspace\\wx",
    });
    expect(() =>
      catalogAutomator.parseCliArguments([
        "C:\\workspace\\wx",
        "C:\\evidence\\catalog",
        "--unknown",
        "private-value",
      ]),
    ).toThrow("catalog automator arguments are invalid");
  });

  it("prefers the explicit CLI path and otherwise reads only the controlled environment key", () => {
    expect(
      catalogAutomator.buildLaunchOptions(
        "C:\\workspace\\wx",
        "C:\\explicit\\cli.bat",
        {
          WECHAT_DEVTOOLS_CLI_PATH: "C:\\environment\\cli.bat",
          PRIVATE_VALUE: "must-not-leak",
        },
      ),
    ).toEqual({
      cliPath: "C:\\explicit\\cli.bat",
      projectPath: "C:\\workspace\\wx",
    });
    expect(
      catalogAutomator.buildLaunchOptions(
        "C:\\workspace\\wx",
        undefined,
        {
          WECHAT_DEVTOOLS_CLI_PATH: "C:\\environment\\cli.bat",
          PRIVATE_VALUE: "must-not-leak",
        },
      ),
    ).toEqual({
      cliPath: "C:\\environment\\cli.bat",
      projectPath: "C:\\workspace\\wx",
    });
  });

  it("fails safely when no absolute CLI path is available", () => {
    for (const environment of [
      {},
      { WECHAT_DEVTOOLS_CLI_PATH: "" },
      { WECHAT_DEVTOOLS_CLI_PATH: "relative/cli" },
    ]) {
      expect(() =>
        catalogAutomator.buildLaunchOptions(
          "C:\\workspace\\wx",
          undefined,
          environment,
        ),
      ).toThrow("WeChat DevTools CLI path is required");
    }
  });

  it("passes the complete launch options to the injected automator", async () => {
    const miniProgram = {};
    const automatorApi = {
      launch: vi.fn(async () => miniProgram),
    };
    const options = {
      cliPath: "C:\\tools\\wechat\\cli.bat",
      projectPath: "C:\\workspace\\wx",
    };

    await expect(
      catalogAutomator.launchMiniProgram(automatorApi, options),
    ).resolves.toBe(miniProgram);
    expect(automatorApi.launch).toHaveBeenCalledOnce();
    expect(automatorApi.launch).toHaveBeenCalledWith(options);
  });
});

describe("catalog automator deterministic search fixture", () => {
  it("exports only the canonical Hangzhou catalog fixture", () => {
    expect(catalogAutomator.CATALOG_SEARCH_FIXTURE).toEqual({
      city: {
        id: "10000000-0000-4000-8000-000000000001",
        code: "330100",
        name: "杭州",
      },
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 3,
    });
    expect(
      JSON.stringify(catalogAutomator.CATALOG_SEARCH_FIXTURE),
    ).not.toMatch(/token|authorization|longitude|latitude|user/i);
  });

  it("sets the real shared store before relaunching home and is repeatable", async () => {
    const events = [];
    const searchStore = {
      set: vi.fn((fixture) => structuredClone(fixture)),
    };
    vi.stubGlobal("getApp", () => ({
      globalData: { searchStore },
    }));
    const miniprogram = {
      evaluate: vi.fn(async (callback, fixture) => {
        events.push("evaluate");
        return callback(fixture);
      }),
      reLaunch: vi.fn(async (url) => {
        events.push(`reLaunch:${url}`);
      }),
    };

    await catalogAutomator.prepareCatalogHome(miniprogram);
    await catalogAutomator.prepareCatalogHome(miniprogram);

    expect(events).toEqual([
      "evaluate",
      "reLaunch:/pages/home/home",
      "evaluate",
      "reLaunch:/pages/home/home",
    ]);
    expect(searchStore.set).toHaveBeenCalledTimes(2);
    expect(searchStore.set).toHaveBeenNthCalledWith(
      1,
      catalogAutomator.CATALOG_SEARCH_FIXTURE,
    );
    expect(searchStore.set).toHaveBeenNthCalledWith(
      2,
      catalogAutomator.CATALOG_SEARCH_FIXTURE,
    );
  });
});

describe("catalog automator bounded and safe failures", () => {
  it("applies the caller's bounded launch timeout", async () => {
    const automatorApi = {
      launch: vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({}), 20);
          }),
      ),
    };

    await expect(
      catalogAutomator.launchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        1,
      ),
    ).rejects.toThrow("launch mini-program timed out");
  });

  it("keeps only a whitelisted step and safe route while capturing evidence and closing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-automator-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "wx");
    const evidencePath = path.join(root, "evidence");
    await mkdir(projectPath);
    const close = vi.fn(async () => {});
    const pageRoot = {
      attribute: vi.fn(async () => "page-shell home"),
      outerWxml: vi.fn(async () => '<view class="page-shell home">安全页面</view>'),
    };
    const page = {
      path: "pages/home/home",
      $: vi.fn(async (selector) =>
        [".home", ".page-shell"].includes(selector) ? pageRoot : null,
      ),
    };
    const miniProgram = {
      close,
      currentPage: vi.fn(async () => page),
      evaluate: vi.fn(async () => {
        throw new Error(
          "Bearer access_token=private selector=.secret AppID=private",
        );
      }),
      screenshot: vi.fn(async ({ path: screenshotPath }) => {
        await writeFile(screenshotPath, "safe-image");
      }),
    };
    const automatorApi = {
      launch: vi.fn(async () => miniProgram),
    };

    let failure;
    try {
      await catalogAutomator.run(
        projectPath,
        evidencePath,
        path.join(root, "wechat-cli.bat"),
        { automatorApi, environment: {} },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: "catalog automation failed",
      step: "fixture",
      currentPage: "pages/home/home",
      evidencePaths: ["99-failure.tree.wxml", "99-failure.png"],
    });
    const exposedFailure = JSON.stringify({
      message: failure.message,
      step: failure.step,
      currentPage: failure.currentPage,
      evidencePaths: failure.evidencePaths,
    });
    expect(exposedFailure).not.toMatch(
      /Bearer|access_token|private|selector|AppID/i,
    );
    await expect(
      readFile(path.join(evidencePath, "99-failure.tree.wxml"), "utf8"),
    ).resolves.toContain("安全页面");
    await expect(
      readFile(path.join(evidencePath, "99-failure.png"), "utf8"),
    ).resolves.toBe("safe-image");
    expect(close).toHaveBeenCalledOnce();
    expect(automatorApi.launch).toHaveBeenCalledWith({
      cliPath: path.join(root, "wechat-cli.bat"),
      projectPath,
    });
  });
});
