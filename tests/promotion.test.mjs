import test from "node:test";
import assert from "node:assert/strict";
import { newer } from "../scripts/bundles.mjs";
test("release comparisons reject numerical downgrades", () => {
  assert(newer("0.12.0", "0.11.9"));
  assert(!newer("0.11.9", "0.12.0"));
  assert(!newer("0.12.0", "0.12.0"));
});
