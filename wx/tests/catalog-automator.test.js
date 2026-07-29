import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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

async function createWindowsCliLayout() {
  const installRoot = await mkdtemp(
    path.join(tmpdir(), "stay-fable-wechat-cli-"),
  );
  temporaryDirectories.push(installRoot);
  const cliPath = path.join(installRoot, "cli.bat");
  const cliEntryPath = path.join(
    installRoot,
    "resources",
    "app.asar.unpacked",
    "js",
    "common",
    "cli",
    "index.js",
  );
  const electronPath = path.join(installRoot, "微信开发者工具.exe");
  await mkdir(path.dirname(cliEntryPath), { recursive: true });
  await Promise.all([
    writeFile(cliPath, "@echo off\r\n", "utf8"),
    writeFile(cliEntryPath, "module.exports = {};\n", "utf8"),
    writeFile(electronPath, "test runtime\n", "utf8"),
  ]);
  return { cliEntryPath, cliPath, electronPath, installRoot };
}

function createChildProcess({ exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.unref = vi.fn();
  child.kill = vi.fn(() => {
    if (exitOnKill) {
      queueMicrotask(() => child.emit("exit", null));
    }
    return exitOnKill;
  });
  return child;
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

  it("resolves only the canonical official Windows CLI layout", async () => {
    const layout = await createWindowsCliLayout();

    await expect(
      catalogAutomator.resolveWindowsCliRuntime(layout.cliPath),
    ).resolves.toEqual({
      cliEntryPath: await realpath(layout.cliEntryPath),
      electronPath: await realpath(layout.electronPath),
      installRoot: await realpath(layout.installRoot),
    });
  });

  it.each([
    {
      label: "missing batch CLI",
      mutate: async ({ cliPath }) => rm(cliPath),
      message: "WeChat DevTools batch CLI is unavailable",
    },
    {
      label: "batch CLI directory",
      mutate: async ({ cliPath }) => {
        await rm(cliPath);
        await mkdir(cliPath);
      },
      message: "WeChat DevTools batch CLI is unavailable",
    },
    {
      label: "missing CLI entry",
      mutate: async ({ cliEntryPath }) => rm(cliEntryPath),
      message: "WeChat DevTools CLI entry is unavailable",
    },
    {
      label: "CLI entry directory",
      mutate: async ({ cliEntryPath }) => {
        await rm(cliEntryPath);
        await mkdir(cliEntryPath);
      },
      message: "WeChat DevTools CLI entry is unavailable",
    },
    {
      label: "missing Electron runtime",
      mutate: async ({ electronPath }) => rm(electronPath),
      message: "WeChat DevTools Electron runtime is unavailable",
    },
    {
      label: "Electron runtime directory",
      mutate: async ({ electronPath }) => {
        await rm(electronPath);
        await mkdir(electronPath);
      },
      message: "WeChat DevTools Electron runtime is unavailable",
    },
  ])("rejects $label without exposing its path", async ({ message, mutate }) => {
    const layout = await createWindowsCliLayout();
    await mutate(layout);

    await expect(
      catalogAutomator.resolveWindowsCliRuntime(layout.cliPath),
    ).rejects.toThrow(message);
    await expect(
      catalogAutomator.resolveWindowsCliRuntime(layout.cliPath),
    ).rejects.not.toThrow(layout.installRoot);
  });

  it("rejects an official layout file that resolves outside the install root", async () => {
    const layout = await createWindowsCliLayout();
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), "stay-fable-wechat-outside-"),
    );
    temporaryDirectories.push(outsideRoot);
    const outsideRuntime = path.join(outsideRoot, "runtime.exe");
    await writeFile(outsideRuntime, "outside\n", "utf8");
    await rm(layout.electronPath);
    await symlink(outsideRuntime, layout.electronPath, "file");

    await expect(
      catalogAutomator.resolveWindowsCliRuntime(layout.cliPath),
    ).rejects.toThrow("WeChat DevTools Electron runtime is unavailable");
  });

  it("uses the official Electron CLI entry for a Windows batch launcher", async () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    child.unref = vi.fn();
    const miniProgram = {
      disconnect: vi.fn(),
    };
    const automatorApi = {
      connect: vi.fn(async () => miniProgram),
      launch: vi.fn(async () => {
        throw new Error("the batch file must not be spawned by Node");
      }),
    };
    const spawnProcess = vi.fn(() => child);
    const launchOptions = {
      cliPath: "C:\\tools\\wechat\\cli.bat",
      cwd: "C:\\controlled\\catalog-cwd",
      projectPath: "C:\\workspace\\wx",
    };
    const runtime = {
      cliEntryPath:
        "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
      electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
      installRoot: "C:\\tools\\wechat",
    };

    const selectedApi = catalogAutomator.selectDefaultAutomatorApi(
      automatorApi,
      launchOptions,
      {
        allocatePort: vi.fn(async () => 45123),
        environment: {
          CWD: "unsafe",
          cWd: "also unsafe",
          cwd: "still unsafe",
          eLeCtRoN: "unsafe",
          Electron_Run_As_Node: "unsafe",
          node_CHANNEL_fd: "unsafe",
          Node_Channel_Serialization_Mode: "unsafe",
          node_options: "--require unsafe",
          NODE_Path: "unsafe",
          Node_Repl_external_module: "unsafe",
          SAFE_VALUE: "present",
        },
        platform: "win32",
        resolveWindowsCliRuntime: vi.fn(async () => runtime),
        sleep: vi.fn(async () => {}),
        spawnProcess,
      },
    );

    await expect(selectedApi.launch(launchOptions)).resolves.toBe(
      miniProgram,
    );
    expect(automatorApi.launch).not.toHaveBeenCalled();
    expect(automatorApi.connect).toHaveBeenCalledWith({
      wsEndpoint: "ws://127.0.0.1:45123",
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0][0]).toBe(runtime.electronPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        runtime.cliEntryPath,
        "auto",
        "--project",
        launchOptions.projectPath,
        "--auto-port",
        "45123",
      ]),
    );
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({
      cwd: runtime.installRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(spawnProcess.mock.calls[0][2].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      SAFE_VALUE: "present",
    });
    expect(
      Object.keys(spawnProcess.mock.calls[0][2].env).filter((key) =>
        [
          "ELECTRON",
          "NODE_OPTIONS",
          "NODE_PATH",
          "NODE_REPL_EXTERNAL_MODULE",
          "NODE_CHANNEL_FD",
          "NODE_CHANNEL_SERIALIZATION_MODE",
        ].includes(key.toUpperCase()),
      ),
    ).toEqual([]);
    expect(
      Object.keys(spawnProcess.mock.calls[0][2].env).filter(
        (key) => key.toUpperCase() === "ELECTRON_RUN_AS_NODE",
      ),
    ).toEqual(["ELECTRON_RUN_AS_NODE"]);
    expect(
      Object.keys(spawnProcess.mock.calls[0][2].env).filter(
        (key) => key.toUpperCase() === "CWD",
      ),
    ).toEqual(["cwd"]);
    expect(spawnProcess.mock.calls[0][2].env.cwd).toBe(
      launchOptions.cwd,
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("keeps a successful connection when the cold-start CLI then exits cleanly", async () => {
    const child = createChildProcess();
    const miniProgram = { disconnect: vi.fn() };
    const automatorApi = {
      connect: vi.fn(async () => {
        queueMicrotask(() => child.emit("exit", 0));
        return miniProgram;
      }),
    };

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort: vi.fn(async () => 45123),
          postConnectMs: 5,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          spawnProcess: vi.fn(() => child),
        },
      ),
    ).resolves.toBe(miniProgram);
    expect(miniProgram.disconnect).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("sanitizes a synchronous Windows runtime spawn failure", async () => {
    const sensitivePath = "C:\\private\\user\\微信开发者工具.exe";

    const launched = catalogAutomator.launchWindowsBatchMiniProgram(
      { connect: vi.fn() },
      {
        cliPath: "C:\\tools\\wechat\\cli.bat",
        projectPath: "C:\\workspace\\wx",
      },
      {
        allocatePort: vi.fn(async () => 45123),
        resolveWindowsCliRuntime: vi.fn(async () => ({
          cliEntryPath:
            "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
          electronPath: sensitivePath,
          installRoot: "C:\\tools\\wechat",
        })),
        spawnProcess: vi.fn(() => {
          throw new Error(`spawn failed: ${sensitivePath}`);
        }),
      },
    );

    await expect(launched).rejects.toThrow(
      "WeChat DevTools CLI exited unexpectedly",
    );
    await expect(launched).rejects.not.toThrow(sensitivePath);
  });

  it.each([
    { cliPath: "/opt/wechat-devtools/cli", platform: "linux" },
    { cliPath: "C:\\tools\\wechat\\cli.exe", platform: "win32" },
  ])(
    "keeps the official launch path for $platform $cliPath",
    async ({ cliPath, platform }) => {
      const miniProgram = {};
      const automatorApi = {
        connect: vi.fn(),
        launch: vi.fn(async () => miniProgram),
      };
      const launchOptions = {
        cliPath,
        projectPath:
          platform === "win32" ? "C:\\workspace\\wx" : "/workspace/wx",
      };

      const selectedApi = catalogAutomator.selectDefaultAutomatorApi(
        automatorApi,
        launchOptions,
        { platform },
      );

      expect(selectedApi).toBe(automatorApi);
      await expect(selectedApi.launch(launchOptions)).resolves.toBe(
        miniProgram,
      );
      expect(automatorApi.connect).not.toHaveBeenCalled();
    },
  );

  it("reports that the target window must be closed when the cold-start CLI exits cleanly", async () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    child.unref = vi.fn();
    const automatorApi = {
      connect: vi.fn(async () => {
        child.emit("exit", 0);
        throw new Error("endpoint unavailable");
      }),
    };

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort: vi.fn(async () => 45123),
          exitGraceMs: 0,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          sleep: vi.fn(async () => {}),
          spawnProcess: vi.fn(() => child),
        },
      ),
    ).rejects.toThrow(
      "WeChat DevTools project window must be closed before automation launch",
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds a non-settling connection, waits for child exit, and disconnects a late result", async () => {
    const connection = deferred();
    const events = [];
    const child = createChildProcess({ exitOnKill: false });
    child.kill.mockImplementation(() => {
      events.push("kill");
      setTimeout(() => {
        events.push("exit");
        child.emit("exit", null);
      }, 10);
      return true;
    });
    const lateMiniProgram = { disconnect: vi.fn() };
    const automatorApi = {
      connect: vi.fn(() => connection.promise),
    };
    const launchOptions = {
      cliPath: "C:\\tools\\wechat\\cli.bat",
      projectPath: "C:\\workspace\\wx",
    };
    const selectedApi = catalogAutomator.selectDefaultAutomatorApi(
      automatorApi,
      launchOptions,
      {
        allocatePort: vi.fn(async () => 45123),
        cleanupTimeoutMs: 50,
        connectTimeoutMs: 1_000,
        platform: "win32",
        resolveWindowsCliRuntime: vi.fn(async () => ({
          cliEntryPath:
            "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
          electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
          installRoot: "C:\\tools\\wechat",
        })),
        spawnProcess: vi.fn(() => child),
      },
    );

    await expect(
      catalogAutomator
        .launchMiniProgram(selectedApi, launchOptions, 5)
        .catch((error) => {
          events.push("rejected");
          throw error;
        }),
    ).rejects.toThrow("launch mini-program timed out");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(events).toEqual(["kill", "exit", "rejected"]);

    connection.resolve(lateMiniProgram);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateMiniProgram.disconnect).toHaveBeenCalledOnce();
  });

  it("does not spawn after an outer timeout wins during port allocation", async () => {
    const allocation = deferred();
    const spawnProcess = vi.fn(() => createChildProcess());
    const launchOptions = {
      cliPath: "C:\\tools\\wechat\\cli.bat",
      projectPath: "C:\\workspace\\wx",
    };
    const selectedApi = catalogAutomator.selectDefaultAutomatorApi(
      { connect: vi.fn() },
      launchOptions,
      {
        allocatePort: vi.fn(() => allocation.promise),
        environment: { SAFE_VALUE: "present" },
        platform: "win32",
        resolveWindowsCliRuntime: vi.fn(async () => ({
          cliEntryPath:
            "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
          electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
          installRoot: "C:\\tools\\wechat",
        })),
        spawnProcess,
      },
    );
    setTimeout(() => allocation.resolve(45123), 10);

    await expect(
      catalogAutomator.launchMiniProgram(selectedApi, launchOptions, 5),
    ).rejects.toThrow("launch mini-program timed out");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("force-kills once and returns a fixed cleanup failure when the child never exits", async () => {
    const child = createChildProcess({ exitOnKill: false });
    child.kill.mockReturnValue(true);
    const allocatePort = vi.fn(async () => 45123);
    const spawnProcess = vi.fn(() => child);
    const automatorApi = {
      connect: vi.fn(async () => {
        throw new Error("C:\\private\\user\\endpoint failure");
      }),
    };
    const startedAt = Date.now();
    const launched = Promise.race([
      catalogAutomator.launchWindowsBatchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort,
          cleanupTimeoutMs: 5,
          connectTimeoutMs: 5,
          forceCleanupTimeoutMs: 5,
          pollIntervalMs: 0,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          sleep: vi.fn(async () => {}),
          spawnProcess,
        },
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("test safety deadline")), 100),
      ),
    ]);

    await expect(launched).rejects.toThrow(
      "WeChat DevTools CLI cleanup failed",
    );
    await expect(launched).rejects.not.toThrow("private");
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("retries one early nonzero CLI exit only after the first child is terminal", async () => {
    const events = [];
    const firstChild = createChildProcess();
    const secondChild = createChildProcess();
    const ports = [45123, 45124];
    const miniProgram = { disconnect: vi.fn() };
    const automatorApi = {
      connect: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push("first:exit");
          firstChild.emit("exit", 1);
          throw new Error("endpoint unavailable");
        })
        .mockResolvedValueOnce(miniProgram),
    };
    const allocatePort = vi.fn(async () => {
      const port = ports[allocatePort.mock.calls.length - 1];
      events.push(`allocate:${port}`);
      return port;
    });
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("first:spawn");
        return firstChild;
      })
      .mockImplementationOnce(() => {
        events.push("second:spawn");
        return secondChild;
      });

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort,
          cleanupTimeoutMs: 50,
          connectTimeoutMs: 100,
          postConnectMs: 0,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          spawnProcess,
        },
      ),
    ).resolves.toBe(miniProgram);
    expect(allocatePort).toHaveBeenCalledTimes(2);
    expect(automatorApi.connect.mock.calls.map(([value]) => value)).toEqual([
      { wsEndpoint: "ws://127.0.0.1:45123" },
      { wsEndpoint: "ws://127.0.0.1:45124" },
    ]);
    expect(events).toEqual([
      "allocate:45123",
      "first:spawn",
      "first:exit",
      "allocate:45124",
      "second:spawn",
    ]);
    expect(firstChild.kill).not.toHaveBeenCalled();
  });

  it("does not change ports for ordinary connection errors while the child is running", async () => {
    const child = createChildProcess();
    const allocatePort = vi.fn(async () => 45123);
    const spawnProcess = vi.fn(() => child);

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        {
          connect: vi.fn(async () => {
            throw new Error("endpoint unavailable");
          }),
        },
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort,
          cleanupTimeoutMs: 20,
          connectTimeoutMs: 5,
          pollIntervalMs: 0,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          sleep: vi.fn(async () => {}),
          spawnProcess,
        },
      ),
    ).rejects.toThrow("WeChat DevTools automation endpoint is unavailable");
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("does not retry a nonzero child exit after a connection was established", async () => {
    const child = createChildProcess();
    const miniProgram = { disconnect: vi.fn() };
    const allocatePort = vi.fn(async () => 45123);
    const spawnProcess = vi.fn(() => child);

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        {
          connect: vi.fn(async () => miniProgram),
        },
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort,
          postConnectMs: 20,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          sleep: vi.fn(() => {
            child.emit("exit", 1);
            return new Promise(() => {
              // The child terminal event must win the post-connect wait.
            });
          }),
          spawnProcess,
        },
      ),
    ).rejects.toThrow("WeChat DevTools CLI exited unexpectedly");
    expect(miniProgram.disconnect).toHaveBeenCalledOnce();
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("does not retry a clean CLI exit that indicates an already-open target window", async () => {
    const child = createChildProcess();
    const allocatePort = vi.fn(async () => 45123);
    const spawnProcess = vi.fn(() => child);
    const automatorApi = {
      connect: vi.fn(async () => {
        child.emit("exit", 0);
        throw new Error("endpoint unavailable");
      }),
    };

    await expect(
      catalogAutomator.launchWindowsBatchMiniProgram(
        automatorApi,
        {
          cliPath: "C:\\tools\\wechat\\cli.bat",
          projectPath: "C:\\workspace\\wx",
        },
        {
          allocatePort,
          exitGraceMs: 0,
          resolveWindowsCliRuntime: vi.fn(async () => ({
            cliEntryPath:
              "C:\\tools\\wechat\\resources\\app.asar.unpacked\\js\\common\\cli\\index.js",
            electronPath: "C:\\tools\\wechat\\微信开发者工具.exe",
            installRoot: "C:\\tools\\wechat",
          })),
          sleep: vi.fn(async () => {}),
          spawnProcess,
        },
      ),
    ).rejects.toThrow(
      "WeChat DevTools project window must be closed before automation launch",
    );
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
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
      evaluate: vi.fn(async (callback, ...arguments_) => {
        events.push("evaluate");
        return callback(...arguments_);
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

  it("uses a unique token for every catalog fixture apply", async () => {
    const searchStore = {
      get: vi.fn(() => undefined),
      set: vi.fn((fixture) => structuredClone(fixture)),
    };
    vi.stubGlobal("getApp", () => ({ globalData: { searchStore } }));
    const runtimeTokens = [];
    const miniprogram = {
      evaluate: vi.fn(async (callback, ...arguments_) => {
        if (callback.toString().includes("store.set(value)")) {
          runtimeTokens.push(arguments_[0]);
        }
        return callback(...arguments_);
      }),
      reLaunch: vi.fn(async () => {}),
    };
    const applies = [];

    await catalogAutomator.prepareCatalogHome(miniprogram, undefined, {
      onApply: (apply) => applies.push(apply),
    });
    await catalogAutomator.prepareCatalogHome(miniprogram, undefined, {
      onApply: (apply) => applies.push(apply),
    });

    expect(applies[0]).toMatchObject({ token: expect.any(String) });
    expect(applies[1]).toMatchObject({ token: expect.any(String) });
    expect(applies[0].token).not.toBe(applies[1].token);
    expect(runtimeTokens).toEqual(applies.map((apply) => apply.token));
  });

  it("recreates plain search snapshots inside the Automator runtime", async () => {
    const original = {
      city: null,
      checkin: "2026-08-02",
      checkout: "2026-08-03",
      guests: 2,
    };
    let search = structuredClone(original);
    const searchStore = {
      get: vi.fn(() => structuredClone(search)),
      set: vi.fn((value) => {
        if (
          Object.getPrototypeOf(value) !== Object.prototype ||
          (value.city !== null &&
            Object.getPrototypeOf(value.city) !== Object.prototype)
        ) {
          throw new Error("Invalid search context");
        }
        search = structuredClone(value);
        return structuredClone(search);
      }),
    };
    vi.stubGlobal("getApp", () => ({
      globalData: { searchStore },
    }));
    const miniprogram = {
      evaluate: vi.fn(async (callback, ...arguments_) => {
        const bridgedArguments = arguments_.map((argument) => {
          if (argument === null || typeof argument !== "object") {
            return argument;
          }
          return Object.assign(
            Object.create({ automatorTransport: true }),
            structuredClone(argument),
          );
        });
        return callback(...bridgedArguments);
      }),
      reLaunch: vi.fn(async () => {}),
    };
    let apply;

    await catalogAutomator.prepareCatalogHome(miniprogram, undefined, {
      onApply(value) {
        apply = value;
      },
    });
    expect(search).toEqual(catalogAutomator.CATALOG_SEARCH_FIXTURE);

    await catalogAutomator.restoreCatalogSearch(
      miniprogram,
      apply,
      { hasValue: true, value: original },
      catalogAutomator.createCancellationContext(),
    );
    expect(search).toEqual(original);
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

  it("keeps the original search when fixture apply settles beyond cleanup", async () => {
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
      2,
    );
    expect(events.lastIndexOf("restore")).toBeLessThan(
      events.indexOf("apply-response"),
    );
    expect(events.indexOf("close")).toBeLessThan(events.indexOf("apply-response"));
    expect(miniProgram.readSearch()).toEqual(original);
  });

  it("skips a queued fixture apply that executes after the runtime closes", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-12",
      checkout: "2026-08-13",
      guests: 2,
    };
    let search = structuredClone(original);
    let closed = false;
    let finishApply;
    let evaluateAfterClose = 0;
    const applyResponse = deferred();
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
      close: vi.fn(async () => {
        events.push("close");
        closed = true;
      }),
      currentPage: vi.fn(async () => null),
      evaluate: vi.fn((callback, ...arguments_) => {
        if (closed) {
          evaluateAfterClose += 1;
          return Promise.reject(new Error("runtime closed"));
        }
        const source = callback.toString();
        if (source.includes("store.set(value)")) {
          finishApply = () => {
            events.push("late-apply");
            const result = callback(...arguments_);
            applyResponse.resolve(result);
            return result;
          };
          return applyResponse.promise;
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
    ).rejects.toMatchObject({
      message: "catalog automation failed",
      step: "fixture",
    });
    expect(events.at(-1)).toBe("close");

    expect(finishApply()).toEqual({ status: "skipped" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(evaluateAfterClose).toBe(0);
    expect(miniProgram.readSearch()).toEqual(original);
  });

  it("restores an apply that runs before its cancellation tombstone", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-14",
      checkout: "2026-08-15",
      guests: 3,
    };
    let search = structuredClone(original);
    let applyToken;
    let restoreToken;
    const store = {
      get: vi.fn(() => structuredClone(search)),
      set: vi.fn((value) => {
        search = structuredClone(value);
        return structuredClone(search);
      }),
    };
    vi.stubGlobal("getApp", () => ({ globalData: { searchStore: store } }));
    const miniProgram = {
      close: vi.fn(async () => {}),
      currentPage: vi.fn(async () => null),
      evaluate: vi.fn((callback, ...arguments_) => {
        const source = callback.toString();
        if (source.includes("store.set(value)")) {
          [applyToken] = arguments_;
          const result = callback(...arguments_);
          return new Promise((resolve) => setTimeout(() => resolve(result), 20));
        }
        if (source.includes("snapshot.hasValue")) {
          [restoreToken] = arguments_;
        }
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

    expect(applyToken).toEqual(expect.any(String));
    expect(restoreToken).toBe(applyToken);
    expect(miniProgram.readSearch()).toEqual(original);
  });

  it("closes with a safe cleanup failure when no tombstone restore succeeds", async () => {
    const { evidencePath, projectPath, root } = await createRunPaths();
    const original = {
      city: null,
      checkin: "2026-08-16",
      checkout: "2026-08-17",
      guests: 4,
    };
    let evaluateCalls = 0;
    const close = vi.fn(async () => {});
    const miniProgram = {
      close,
      currentPage: vi.fn(async () => null),
      evaluate: vi.fn((callback, ...arguments_) => {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          return callback(...arguments_);
        }
        if (callback.toString().includes("store.set(value)")) {
          return new Promise(() => {});
        }
        return Promise.reject(
          new Error("Bearer private cleanup failure selector=.secret"),
        );
      }),
      reLaunch: vi.fn(async () => {}),
    };
    vi.stubGlobal("getApp", () => ({
      globalData: {
        searchStore: {
          get: () => structuredClone(original),
          set: (value) => structuredClone(value),
        },
      },
    }));

    let error;
    try {
      await catalogAutomator.run(
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
      );
    } catch (caught) {
      error = caught;
    }

    expect(close).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      message: "catalog automation failed",
      step: "cleanup",
    });
    expect(JSON.stringify(catalogAutomator.formatCatalogFailure(error))).not.toMatch(
      /Bearer|private|selector/i,
    );
  });
});
