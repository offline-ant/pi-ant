import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Match Pi's runtime: peer imports come from the globally installed CLI,
// never from an extension-local npm install or the reference source checkout.
export const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
export const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
export const piResolutionFile = join(piRoot, "pi-ant-resolution.mjs");
export function isPiPeer(specifier) {
  return specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, isPiPeer(specifier)
      ? { ...context, parentURL: pathToFileURL(piResolutionFile).href }
      : context);
  },
});
