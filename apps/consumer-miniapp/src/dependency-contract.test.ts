import semver from "semver";
import { describe, expect, it } from "vitest";

import taroReactPackage from "@tarojs/react/package.json";

import consumerPackage from "../package.json";

describe("consumer dependency contract", () => {
  it("uses a React version accepted by @tarojs/react", () => {
    expect(
      semver.satisfies(consumerPackage.dependencies.react, taroReactPackage.peerDependencies.react),
    ).toBe(true);
  });
});
