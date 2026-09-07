import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { childNestingEnvironment, initializeNesting } from "./nesting.ts";

const DEPTH = Symbol.for("pi-orchestration:nesting-depth");
const globals = globalThis as typeof globalThis & { [DEPTH]?: number };

function withInheritedDepth(value: string | undefined, run: () => void): void {
  const saved = process.env.PI_NESTED;
  const initialized = globals[DEPTH];
  delete globals[DEPTH];
  if (value === undefined) delete process.env.PI_NESTED;
  else process.env.PI_NESTED = value;
  try { run(); }
  finally {
    if (saved === undefined) delete process.env.PI_NESTED;
    else process.env.PI_NESTED = saved;
    if (initialized === undefined) delete globals[DEPTH];
    else globals[DEPTH] = initialized;
  }
}

test("importing nesting, host, and worker helpers neither changes depth nor terminates a deep process", () => {
  const imports = ["nesting.ts", "host.ts", "worker-frame.ts"].map((file) =>
    `import ${JSON.stringify(new URL(file, import.meta.url).href)};`).join("\n");
  const result = spawnSync(process.execPath, [
    "--import", new URL("../scripts/pi-test-imports.mjs", import.meta.url).href,
    "--input-type=module", "-e", `${imports}\nif (process.env.PI_NESTED !== "99") throw new Error("import changed depth");\nconsole.log("imported");`,
  ], { env: { ...process.env, PI_NESTED: "99" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imported");
});

test("session activation initializes root depth and is idempotent across reloads", () => {
  withInheritedDepth(undefined, () => {
    assert.equal(initializeNesting(), 0);
    assert.equal(process.env.PI_NESTED, "0");
    assert.equal(initializeNesting(), 0);
    assert.deepEqual(childNestingEnvironment(), { PI_NESTED: "0" });
  });
  withInheritedDepth("1", () => {
    assert.equal(initializeNesting(), 2);
    assert.equal(initializeNesting(), 2);
    assert.equal(process.env.PI_NESTED, "2");
    assert.deepEqual(childNestingEnvironment(), { PI_NESTED: "2" });
  });
});

test("depth-limit sessions remain usable but cannot create a fourth-level child", () => {
  withInheritedDepth("2", () => {
    assert.equal(initializeNesting(), 3);
    assert.throws(childNestingEnvironment, /nested too deep/);
    assert.equal(initializeNesting(), 3);
    assert.equal(process.env.PI_NESTED, "3");
  });
  withInheritedDepth("99", () => {
    assert.equal(initializeNesting(), 100);
    assert.throws(childNestingEnvironment, /nested too deep/);
  });
});
