import { defineConfig } from "@tarojs/cli";

export default defineConfig({
  projectName: "stay-fable",
  date: "2026-07-27",
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
  },
  sourceRoot: "src",
  outputRoot: `dist/${process.env.TARO_ENV}`,
  framework: "react",
  compiler: "webpack5",
  cache: {
    enable: true,
  },
  mini: {},
});
