import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const rootPackageUrl = new URL("../../package.json", import.meta.url);
const workspaceConfigUrl = new URL("../../pnpm-workspace.yaml", import.meta.url);
const catalogAutomator = require("../automator/slice-2-catalog.js");
const temporaryDirectories = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function runCli(arguments_) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "../automator/slice-2-catalog.js"), ...arguments_],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

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
    const workspaceConfig = require("yaml").parse(
      await readFile(workspaceConfigUrl, "utf8"),
    );

    expect(rootPackage.devDependencies["miniprogram-automator"]).toBe("0.12.1");
    expect(workspaceConfig.overrides).toEqual({
      "@jimp/jpeg@0.6.8>jpeg-js": "0.4.4",
      "mkdirp@0.5.1>minimist": "1.2.8",
    });
    expect(() => require("miniprogram-automator")).not.toThrow();
    expect(() => require("../automator/slice-2-catalog.js")).not.toThrow();

    const automatorEntry = require.resolve("miniprogram-automator");
    const jimpCorePackage = require.resolve("@jimp/core/package.json", {
      paths: [automatorEntry],
    });
    const mkdirpPackage = require.resolve("mkdirp/package.json", {
      paths: [jimpCorePackage],
    });
    const minimistPackage = require(
      require.resolve("minimist/package.json", {
        paths: [mkdirpPackage],
      }),
    );
    const jimpJpegPackage = require.resolve("@jimp/jpeg/package.json", {
      paths: [automatorEntry],
    });
    const jpegJsPackage = require(
      require.resolve("jpeg-js/package.json", {
        paths: [jimpJpegPackage],
      }),
    );

    expect(minimistPackage.version).toBe("1.2.8");
    expect(jpegJsPackage.version).toBe("0.4.4");
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
      "evaluate",
      "reLaunch:/pages/home/home",
      "evaluate",
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

  it("does not relaunch after a deferred fixture write crosses its deadline", async () => {
    const evaluation = deferred();
    const miniprogram = {
      evaluate: vi.fn(() => evaluation.promise),
      reLaunch: vi.fn(async () => {}),
    };
    const context = catalogAutomator.createCancellationContext();

    await expect(
      catalogAutomator.prepareCatalogHome(miniprogram, context, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow("capture catalog search timed out");
    evaluation.resolve(catalogAutomator.CATALOG_SEARCH_FIXTURE);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(context.signal.aborted).toBe(true);
    expect(miniprogram.reLaunch).not.toHaveBeenCalled();
  });
});

describe("catalog automator page polling", () => {
  it("ignores stale pages and resolves the newly current page root", async () => {
    const stalePage = {
      path: "pages/home/home",
      waitFor: vi.fn(
        () =>
          new Promise(() => {
            // A stale page wait must never be started.
          }),
      ),
    };
    const root = {};
    const expectedPage = {
      path: "pages/property-list/property-list",
      $: vi.fn(async () => root),
      data: vi.fn(async () => ({ status: "list" })),
    };
    const miniprogram = {
      currentPage: vi
        .fn()
        .mockResolvedValueOnce(stalePage)
        .mockResolvedValueOnce(stalePage)
        .mockResolvedValue(expectedPage),
    };

    await expect(
      catalogAutomator.waitForPage(
        miniprogram,
        "pages/property-list/property-list",
        ".property-list-page",
        undefined,
        { pollIntervalMs: 0, timeoutMs: 100 },
      ),
    ).resolves.toEqual({
      data: { status: "list" },
      page: expectedPage,
    });
    expect(stalePage.waitFor).not.toHaveBeenCalled();
    expect(expectedPage.$).toHaveBeenCalledWith(".property-list-page");
  });

  it("polls page data without starting an unbounded Page.waitFor task", async () => {
    const page = {
      data: vi
        .fn()
        .mockResolvedValueOnce({ status: "loading" })
        .mockResolvedValue({ status: "list" }),
      waitFor: vi.fn(
        () =>
          new Promise(() => {
            // This legacy task would survive Promise.race timeouts.
          }),
      ),
    };

    await expect(
      catalogAutomator.waitForData(
        page,
        (data) => data.status === "list",
        "property list data",
        catalogAutomator.createCancellationContext(),
        { pollIntervalMs: 0, timeoutMs: 100 },
      ),
    ).resolves.toEqual({ status: "list" });
    expect(page.waitFor).not.toHaveBeenCalled();
  });

  it("polls selectors without starting a container waitFor task", async () => {
    const element = {};
    const container = {
      $: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(element),
      waitFor: vi.fn(
        () =>
          new Promise(() => {
            // This legacy selector waiter must not be used.
          }),
      ),
    };

    await expect(
      catalogAutomator.requireElement(
        container,
        ".search-button",
        catalogAutomator.createCancellationContext(),
        { pollIntervalMs: 0, timeoutMs: 100 },
      ),
    ).resolves.toBe(element);
    expect(container.waitFor).not.toHaveBeenCalled();
  });
});

describe("catalog automator runtime UI evidence", () => {
  const expectedBookingNotice = {
    title: "预订功能即将开放",
    content: "报价与预订将在下一开发切片开放",
    showCancel: false,
  };

  function createModalMiniProgram(confirmModal = vi.fn(async () => ({}))) {
    return {
      evaluate: vi.fn(async (callback, ...arguments_) =>
        callback(...arguments_),
      ),
      native: vi.fn(() => ({ confirmModal })),
    };
  }

  it("polls until the nightly DOM count exactly matches page data", async () => {
    const row = {};
    const page = {
      $$: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row])
        .mockResolvedValue([row, row]),
    };

    await expect(
      catalogAutomator.waitForElementCount(
        page,
        ".nightly-list__item",
        2,
        catalogAutomator.createCancellationContext(),
        { pollIntervalMs: 0, timeoutMs: 100 },
      ),
    ).resolves.toEqual([row, row]);
    expect(page.$$).toHaveBeenCalledTimes(3);
  });

  it("retries the native modal capability until confirm succeeds", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const confirmModal = vi
      .fn()
      .mockRejectedValueOnce(new Error("modal not ready"))
      .mockRejectedValueOnce(new Error("modal not ready"))
      .mockResolvedValue({ confirmed: true });
    const miniprogram = createModalMiniProgram(confirmModal);
    const originalReference = globalThis.wx.showModal;
    const install =
      await catalogAutomator.installBookingModalProbe(miniprogram);
    globalThis.wx.showModal(expectedBookingNotice);

    await expect(
      catalogAutomator.confirmBookingModal(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        { install, pollIntervalMs: 0, timeoutMs: 100 },
      ),
    ).resolves.toEqual({ confirmed: true });
    expect(miniprogram.native).toHaveBeenCalledTimes(3);
    expect(confirmModal).toHaveBeenCalledTimes(3);
    expect(originalShowModal).toHaveBeenCalledWith(expectedBookingNotice);

    await catalogAutomator.restoreBookingModalProbe(miniprogram, install);
    expect(globalThis.wx.showModal).toBe(originalReference);
  });

  it.each([
    {
      title: "任意弹窗",
      content: expectedBookingNotice.content,
      showCancel: false,
    },
    {
      title: expectedBookingNotice.title,
      content: "静态提示不能替代真实预订弹窗",
      showCancel: false,
    },
  ])("rejects a modal with the wrong safe fields: %#", async (notice) => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const confirmModal = vi.fn(async () => ({}));
    const miniprogram = createModalMiniProgram(confirmModal);
    const install =
      await catalogAutomator.installBookingModalProbe(miniprogram);
    globalThis.wx.showModal(notice);

    await expect(
      catalogAutomator.confirmBookingModal(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        { install, pollIntervalMs: 0, timeoutMs: 5 },
      ),
    ).rejects.toThrow("booking modal probe timed out");
    expect(confirmModal).not.toHaveBeenCalled();

    await catalogAutomator.restoreBookingModalProbe(miniprogram, install);
  });

  it("rejects native confirmation when no real modal probe was observed", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const confirmModal = vi.fn(async () => ({}));
    const miniprogram = createModalMiniProgram(confirmModal);
    const install =
      await catalogAutomator.installBookingModalProbe(miniprogram);

    await expect(
      catalogAutomator.confirmBookingModal(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        { install, pollIntervalMs: 0, timeoutMs: 5 },
      ),
    ).rejects.toThrow("booking modal probe timed out");
    expect(confirmModal).not.toHaveBeenCalled();

    await catalogAutomator.restoreBookingModalProbe(miniprogram, install);
  });

  it("restores showModal when probe installation completes remotely but its response is late", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const installResponse = deferred();
    let evaluateCalls = 0;
    const miniprogram = {
      evaluate: vi.fn((callback, ...arguments_) => {
        evaluateCalls += 1;
        const result = callback(...arguments_);
        return evaluateCalls === 1 ? installResponse.promise : result;
      }),
    };
    const operation = vi.fn(async () => {});

    await expect(
      catalogAutomator.withBookingModalProbe(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        operation,
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow("install booking modal probe timed out");
    expect(operation).not.toHaveBeenCalled();
    expect(globalThis.wx.showModal).toBe(originalShowModal);
    installResponse.resolve(true);
  });

  it("uses a unique token for every booking modal probe", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const miniprogram = createModalMiniProgram();

    const first = await catalogAutomator.installBookingModalProbe(miniprogram);
    await catalogAutomator.restoreBookingModalProbe(miniprogram, first);
    const second = await catalogAutomator.installBookingModalProbe(miniprogram);
    await catalogAutomator.restoreBookingModalProbe(miniprogram, second);

    expect(first).toMatchObject({ token: expect.any(String) });
    expect(second).toMatchObject({ token: expect.any(String) });
    expect(first.token).not.toBe(second.token);
    expect(globalThis.wx.showModal).toBe(originalShowModal);
  });

  it("does not wrap showModal when restore records cancellation before a late install", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const installResponse = deferred();
    let finishInstall;
    let evaluateCalls = 0;
    const miniprogram = {
      evaluate: vi.fn((callback, ...arguments_) => {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          finishInstall = () => {
            const result = callback(...arguments_);
            installResponse.resolve(result);
          };
          return installResponse.promise;
        }
        return callback(...arguments_);
      }),
    };

    await expect(
      catalogAutomator.withBookingModalProbe(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        vi.fn(async () => {}),
        { lateSettleMs: 1, timeoutMs: 1 },
      ),
    ).rejects.toThrow("install booking modal probe timed out");

    expect(globalThis.wx.showModal).toBe(originalShowModal);
    finishInstall();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(globalThis.wx.showModal).toBe(originalShowModal);
  });

  it("restores a probe whose install settles after the bounded cleanup wait", async () => {
    const originalShowModal = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("wx", { showModal: originalShowModal });
    const installResponse = deferred();
    let finishInstall;
    let evaluateCalls = 0;
    const miniprogram = {
      evaluate: vi.fn((callback, ...arguments_) => {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          finishInstall = () => {
            const result = callback(...arguments_);
            installResponse.resolve(result);
          };
          return installResponse.promise;
        }
        return callback(...arguments_);
      }),
    };

    await expect(
      catalogAutomator.withBookingModalProbe(
        miniprogram,
        catalogAutomator.createCancellationContext(),
        vi.fn(async () => {}),
        { lateSettleMs: 1, timeoutMs: 1 },
      ),
    ).rejects.toThrow("install booking modal probe timed out");
    finishInstall();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(globalThis.wx.showModal).toBe(originalShowModal);
    expect(miniprogram.evaluate.mock.calls.length).toBeGreaterThanOrEqual(3);
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

  it("closes a mini-program that resolves after the launch timeout", async () => {
    const launch = deferred();
    const close = vi.fn(async () => {});
    const automatorApi = { launch: vi.fn(() => launch.promise) };

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

    launch.resolve({ close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("disconnects when graceful close does not finish in time", async () => {
    const disconnect = vi.fn();
    const miniprogram = {
      close: vi.fn(
        () =>
          new Promise(() => {
            // Simulate a stuck official graceful close.
          }),
      ),
      disconnect,
    };

    await expect(
      catalogAutomator.closeMiniProgram(miniprogram, 1),
    ).rejects.toThrow("close mini-program timed out");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("cancels page polling after its deadline instead of leaving a live loop", async () => {
    const context = catalogAutomator.createCancellationContext();
    const currentPage = vi.fn(async () => ({ path: "pages/home/home" }));

    await expect(
      catalogAutomator.waitForPage(
        { currentPage },
        "pages/property-list/property-list",
        ".property-list-page",
        context,
        { pollIntervalMs: 1, timeoutMs: 5 },
      ),
    ).rejects.toThrow("open pages/property-list/property-list timed out");
    const callsAtTimeout = currentPage.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(context.signal.aborted).toBe(true);
    expect(currentPage).toHaveBeenCalledTimes(callsAtTimeout);
  });

  it("does not publish a screenshot that completes after cancellation", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-evidence-"),
    );
    temporaryDirectories.push(root);
    const screenshot = deferred();
    const miniprogram = {
      screenshot: vi.fn(async ({ path: screenshotPath }) => {
        await screenshot.promise;
        await writeFile(screenshotPath, "late-image");
      }),
    };
    const pageRoot = {
      outerWxml: vi.fn(async () => '<view class="home">安全页面</view>'),
    };
    const page = {
      $: vi.fn(async () => pageRoot),
    };
    const evidencePaths = [];
    const context = catalogAutomator.createCancellationContext();

    await expect(
      catalogAutomator.capturePage(
        miniprogram,
        page,
        ".home",
        root,
        "01-home",
        evidencePaths,
        context,
        { evidenceParent: root, timeoutMs: 1 },
      ),
    ).rejects.toThrow("01-home screenshot timed out");
    screenshot.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(evidencePaths).toEqual(["01-home.tree.wxml"]);
    expect(await readdir(root)).toEqual(["01-home.tree.wxml"]);
  });

  it("preserves screenshot timeout while retrying busy late-temp cleanup", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-busy-evidence-"),
    );
    temporaryDirectories.push(root);
    const screenshot = deferred();
    const removeFile = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("busy private temp"), { code: "EBUSY" }),
      )
      .mockResolvedValue(undefined);
    const miniprogram = {
      screenshot: vi.fn(() => screenshot.promise),
    };
    const page = {
      $: vi.fn(async () => ({
        outerWxml: vi.fn(async () => '<view class="home">安全页面</view>'),
      })),
    };
    const context = catalogAutomator.createCancellationContext();

    const capture = catalogAutomator.capturePage(
      miniprogram,
      page,
      ".home",
      root,
      "01-home",
      [],
      context,
      {
        evidenceParent: root,
        removeFile,
        timeoutMs: 1,
      },
    );
    await expect(capture).rejects.toThrow("01-home screenshot timed out");
    screenshot.resolve();
    await vi.waitFor(() =>
      expect(removeFile.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it("converts malicious preflight paths to fixed safe CLI output", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-preflight-"),
    );
    temporaryDirectories.push(root);
    const maliciousProjectPath = path.join(
      root,
      "access_token=private-project",
    );
    const maliciousEvidencePath = path.join(
      root,
      "Bearer-private-evidence",
    );

    const result = await runCli([
      maliciousProjectPath,
      maliciousEvidencePath,
      "--cli-path",
      path.join(root, "wechat-cli.bat"),
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"message":"catalog automation failed"');
    expect(result.stderr).toContain('"step":"arguments"');
    expect(result.stderr).not.toMatch(
      /access_token|Bearer|private|private-project|private-evidence/i,
    );
  });

  it("validates launch options before creating a run directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-options-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "wx");
    const evidencePath = path.join(root, "evidence");
    await mkdir(projectPath);
    await mkdir(evidencePath);

    await expect(
      catalogAutomator.run(
        projectPath,
        evidencePath,
        "relative/private-cli",
        { environment: {} },
      ),
    ).rejects.toMatchObject({
      message: "catalog automation failed",
      step: "arguments",
      evidencePaths: [],
    });
    expect(await readdir(evidencePath)).toEqual([]);
  });

  it("removes an empty unique run directory when launch fails", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-launch-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "wx");
    const evidencePath = path.join(root, "evidence");
    await mkdir(projectPath);
    const automatorApi = {
      launch: vi.fn(async () => {
        throw new Error("private launch failure");
      }),
    };

    await expect(
      catalogAutomator.run(
        projectPath,
        evidencePath,
        path.join(root, "wechat-cli.bat"),
        { automatorApi, environment: {} },
      ),
    ).rejects.toMatchObject({
      message: "catalog automation failed",
      step: "launch",
      evidencePaths: [],
    });
    expect(await readdir(evidencePath)).toEqual([]);
  });

  it("sanitizes unexpected CLI failure fields before serialization", () => {
    const unsafe = new Error("Bearer access_token=private");
    unsafe.step = "private-step";
    unsafe.currentPage = "pages/private/<token>";
    unsafe.evidencePaths = ["access_token=private.png"];

    expect(catalogAutomator.formatCatalogFailure(unsafe)).toEqual({
      status: "fail",
      message: "catalog automation failed",
      step: "workflow",
      currentPage: "unknown",
      evidencePaths: [],
    });
  });

  it("rolls back an atomic artifact if cancellation fires after linking", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-publish-"),
    );
    temporaryDirectories.push(root);
    const temporaryPath = path.join(root, ".artifact.tmp");
    const finalPath = path.join(root, "artifact.png");
    await writeFile(temporaryPath, "safe-image");
    let checks = 0;
    const context = {
      throwIfAborted() {
        checks += 1;
        if (checks === 2) {
          throw new Error("catalog automation cancelled");
        }
      },
    };

    await expect(
      catalogAutomator.publishTempFile(
        temporaryPath,
        finalPath,
        context,
      ),
    ).rejects.toThrow("catalog automation cancelled");
    await expect(readFile(finalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    });
    expect(failure.evidencePaths).toHaveLength(2);
    expect(failure.evidencePaths[0]).toMatch(
      /^catalog-[\w-]+\/99-failure\.tree\.wxml$/,
    );
    expect(failure.evidencePaths[1]).toMatch(
      /^catalog-[\w-]+\/99-failure\.png$/,
    );
    expect(path.dirname(failure.evidencePaths[0])).toBe(
      path.dirname(failure.evidencePaths[1]),
    );
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
      readFile(path.join(evidencePath, failure.evidencePaths[0]), "utf8"),
    ).resolves.toContain("安全页面");
    await expect(
      readFile(path.join(evidencePath, failure.evidencePaths[1]), "utf8"),
    ).resolves.toBe("safe-image");
    expect(close).toHaveBeenCalledOnce();
    expect(automatorApi.launch).toHaveBeenCalledWith({
      cliPath: path.join(root, "wechat-cli.bat"),
      projectPath,
    });
  });
});

describe("catalog automator isolated runs and search restoration", () => {
  function createMiniProgram(initialSearch) {
    let search = structuredClone(initialSearch);
    const clear = vi.fn(() => {
      search = undefined;
    });
    const store = {
      clear,
      get: vi.fn(() => structuredClone(search)),
      set: vi.fn((value) => {
        search = structuredClone(value);
        return structuredClone(search);
      }),
    };
    vi.stubGlobal("getApp", () => ({ globalData: { searchStore: store } }));
    return {
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (callback, ...arguments_) =>
        callback(...arguments_),
      ),
      reLaunch: vi.fn(async () => {}),
      readSearch: () => structuredClone(search),
      store,
    };
  }

  async function createRunPaths() {
    const root = await mkdtemp(
      path.join(tmpdir(), "stay-fable-catalog-runs-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "wx");
    const evidencePath = path.join(root, "evidence");
    await mkdir(projectPath);
    return { evidencePath, projectPath, root };
  }

  it("creates a unique run directory and restores the prior search after success", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-02",
      checkout: "2026-08-03",
      guests: 2,
    };
    const miniprogram = createMiniProgram(original);
    const workflow = vi.fn(async (_mini, artifact) => ({
      evidencePaths: artifact.evidencePaths,
      status: "safe",
    }));
    const automatorApi = { launch: vi.fn(async () => miniprogram) };

    const first = await catalogAutomator.run(
      projectPath,
      evidencePath,
      path.join(root, "wechat-cli.bat"),
      { automatorApi, environment: {}, workflow },
    );
    const second = await catalogAutomator.run(
      projectPath,
      evidencePath,
      path.join(root, "wechat-cli.bat"),
      { automatorApi, environment: {}, workflow },
    );

    expect(first.status).toBe("safe");
    expect(second.status).toBe("safe");
    expect(miniprogram.readSearch()).toEqual(original);
    const runDirectories = await readdir(evidencePath);
    expect(runDirectories).toHaveLength(2);
    expect(new Set(runDirectories).size).toBe(2);
    expect(runDirectories.every((name) => /^catalog-[\w-]+$/.test(name))).toBe(
      true,
    );
  });

  it("restores the prior search after workflow failure", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-04",
      checkout: "2026-08-05",
      guests: 4,
    };
    const miniprogram = createMiniProgram(original);
    const automatorApi = { launch: vi.fn(async () => miniprogram) };

    await expect(
      catalogAutomator.run(
        projectPath,
        evidencePath,
        path.join(root, "wechat-cli.bat"),
        {
          automatorApi,
          environment: {},
          workflow: vi.fn(async () => {
            throw new Error("private workflow failure");
          }),
        },
      ),
    ).rejects.toMatchObject({
      message: "catalog automation failed",
      step: "home",
    });
    expect(miniprogram.readSearch()).toEqual(original);
  });

  it("clears the fixture when there was no original search", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const miniprogram = createMiniProgram(undefined);
    const automatorApi = { launch: vi.fn(async () => miniprogram) };

    await catalogAutomator.run(
      projectPath,
      evidencePath,
      path.join(root, "wechat-cli.bat"),
      {
        automatorApi,
        environment: {},
        workflow: vi.fn(async (_mini, artifact) => ({
          evidencePaths: artifact.evidencePaths,
        })),
      },
    );

    expect(miniprogram.store.clear.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(miniprogram.readSearch()).toBeUndefined();
  });

  for (const mode of ["set-before-response", "set-after-first-restore"]) {
    it(`restores the original search when fixture apply is late: ${mode}`, async () => {
      const { evidencePath, projectPath, root } = await createRunPaths();
      const original = {
        city: null,
        checkin: "2026-08-06",
        checkout: "2026-08-07",
        guests: 5,
      };
      let search = structuredClone(original);
      const events = [];
      const store = {
        clear: vi.fn(() => {
          search = undefined;
        }),
        get: vi.fn(() => structuredClone(search)),
        set: vi.fn((value) => {
          search = structuredClone(value);
          return structuredClone(search);
        }),
      };
      vi.stubGlobal("getApp", () => ({ globalData: { searchStore: store } }));
      const miniProgram = {
        close: vi.fn(async () => {
          events.push("close");
        }),
        currentPage: vi.fn(async () => null),
        evaluate: vi.fn((callback, ...arguments_) => {
          const source = callback.toString();
          if (source.includes("store.set(value)")) {
            return new Promise((resolve) => {
              const apply = () => {
                events.push("apply-set");
                const result = callback(...arguments_);
                setTimeout(() => {
                  events.push("apply-response");
                  resolve(result);
                }, mode === "set-before-response" ? 15 : 0);
              };
              if (mode === "set-before-response") {
                apply();
              } else {
                setTimeout(apply, 15);
              }
            });
          }
          if (source.includes("snapshot.hasValue")) {
            events.push("restore");
          } else {
            events.push("snapshot");
          }
          return Promise.resolve(callback(...arguments_));
        }),
        reLaunch: vi.fn(async () => {}),
        readSearch: () => structuredClone(search),
      };
      const automatorApi = { launch: vi.fn(async () => miniProgram) };

      await expect(
        catalogAutomator.run(
          projectPath,
          evidencePath,
          path.join(root, "wechat-cli.bat"),
          {
            automatorApi,
            environment: {},
            timeouts: {
              actionMs: 2,
              lateSettleMs: 100,
            },
            workflow: vi.fn(async () => {
              throw new Error("workflow must not start");
            }),
          },
        ),
      ).rejects.toMatchObject({
        message: "catalog automation failed",
        step: "fixture",
      });

      expect(miniProgram.readSearch()).toEqual(original);
      expect(events.filter((event) => event === "snapshot")).toHaveLength(1);
      expect(events.filter((event) => event === "restore").length).toBeGreaterThanOrEqual(
        2,
      );
      expect(events.indexOf("restore")).toBeLessThan(
        events.indexOf("apply-response"),
      );
      expect(events.lastIndexOf("restore")).toBeGreaterThan(
        events.indexOf("apply-response"),
      );
      expect(events.at(-1)).toBe("close");
    });
  }

  it("restores again when apply settles between the first restore and the old condition check", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-08",
      checkout: "2026-08-09",
      guests: 2,
    };
    let search = structuredClone(original);
    const events = [];
    const applyResponse = deferred();
    let finishApply;
    const store = {
      get: vi.fn(() => structuredClone(search)),
      set: vi.fn((value) => {
        search = structuredClone(value);
        return structuredClone(search);
      }),
    };
    vi.stubGlobal("getApp", () => ({ globalData: { searchStore: store } }));
    const miniProgram = {
      close: vi.fn(async () => events.push("close")),
      currentPage: vi.fn(async () => null),
      evaluate: vi.fn((callback, ...arguments_) => {
        const source = callback.toString();
        if (source.includes("store.set(value)")) {
          finishApply = () => {
            events.push("apply-set");
            const result = callback(...arguments_);
            events.push("apply-response");
            applyResponse.resolve(result);
          };
          return applyResponse.promise;
        }
        if (source.includes("snapshot.hasValue")) {
          events.push("restore");
          const restored = callback(...arguments_);
          if (events.filter((event) => event === "restore").length === 1) {
            finishApply();
          }
          return Promise.resolve(restored);
        }
        events.push("snapshot");
        return Promise.resolve(callback(...arguments_));
      }),
      reLaunch: vi.fn(async () => {}),
      readSearch: () => structuredClone(search),
    };

    await expect(
      catalogAutomator.run(
        projectPath,
        evidencePath,
        path.join(root, "wechat-cli.bat"),
        {
          automatorApi: { launch: vi.fn(async () => miniProgram) },
          environment: {},
          timeouts: { actionMs: 1, lateSettleMs: 100 },
          workflow: vi.fn(async () => {
            throw new Error("workflow must not start");
          }),
        },
      ),
    ).rejects.toMatchObject({ step: "fixture" });

    expect(events.filter((event) => event === "restore").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(miniProgram.readSearch()).toEqual(original);
    expect(events.at(-1)).toBe("close");
  });

  it("restores after fixture apply settles beyond the bounded cleanup wait", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-10",
      checkout: "2026-08-11",
      guests: 1,
    };
    let search = structuredClone(original);
    const events = [];
    const store = {
      get: vi.fn(() => structuredClone(search)),
      set: vi.fn((value) => {
        search = structuredClone(value);
        return structuredClone(search);
      }),
    };
    vi.stubGlobal("getApp", () => ({ globalData: { searchStore: store } }));
    const miniProgram = {
      close: vi.fn(async () => events.push("close")),
      currentPage: vi.fn(async () => null),
      evaluate: vi.fn((callback, ...arguments_) => {
        const source = callback.toString();
        if (source.includes("store.set(value)")) {
          return new Promise((resolve) => {
            setTimeout(() => {
              events.push("apply-set");
              const result = callback(...arguments_);
              events.push("apply-response");
              resolve(result);
            }, 20);
          });
        }
        events.push(source.includes("snapshot.hasValue") ? "restore" : "snapshot");
        return Promise.resolve(callback(...arguments_));
      }),
      reLaunch: vi.fn(async () => {}),
      readSearch: () => structuredClone(search),
    };

    await expect(
      catalogAutomator.run(
        projectPath,
        evidencePath,
        path.join(root, "wechat-cli.bat"),
        {
          automatorApi: { launch: vi.fn(async () => miniProgram) },
          environment: {},
          timeouts: { actionMs: 1, lateSettleMs: 1 },
          workflow: vi.fn(async () => {
            throw new Error("workflow must not start");
          }),
        },
      ),
    ).rejects.toMatchObject({ step: "fixture" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events.filter((event) => event === "restore").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(events.lastIndexOf("restore")).toBeGreaterThan(
      events.indexOf("apply-response"),
    );
    expect(miniProgram.readSearch()).toEqual(original);
  });
});
