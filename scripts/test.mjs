import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2);
if (!files.length || files.some((file) => !file.endsWith(".test.ts") || !statSync(resolve(file)).isFile())) {
  throw new Error("Usage: node scripts/test.mjs path/to/specific.test.ts [...specific.test.ts]");
}
const env = { ...process.env };
// Test processes are not child workers. Native smoke fixtures set their own
// explicit environments; inherited worker depth must not terminate unit tests.
delete env.PI_NESTED;
const result = spawnSync(process.execPath, [
  "--import", resolve(root, "scripts/pi-test-imports.mjs"),
  "--test", ...files.map((file) => resolve(file)),
], { stdio: "inherit", env });
if (result.error) throw result.error;
if (result.signal) throw new Error(`Focused tests terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
