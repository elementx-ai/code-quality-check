import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { builtinModules } from "node:module";

const nodeBuiltins = builtinModules.flatMap((mod) => [mod, `node:${mod}`]);

export default {
  input: "src/index.ts",
  output: {
    file: "dist/index.mjs",
    format: "es",
    sourcemap: false,
  },
  external: nodeBuiltins,
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json(),
    typescript({ tsconfig: "./tsconfig.json" }),
  ],
};
