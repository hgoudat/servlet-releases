import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateRun,
  validateBundle,
  matchBundles,
  releaseManifest,
  sha256,
} from "../scripts/bundles.mjs";
import { downloadArtifact, verifyPublic } from "../scripts/github.mjs";
const config = JSON.parse(fs.readFileSync("bridge-config.json"));
const run = {
  id: 123,
  repository: {
    id: config.sourceRepositoryId,
    full_name: config.sourceRepository,
  },
  status: "completed",
  conclusion: "success",
  event: "push",
  path: ".github/workflows/desktop-release-build.yml",
  head_sha: "a".repeat(40),
};
function bundle(
  platform,
  filename,
  bytes = Buffer.from("compiled-test-fixture"),
) {
  return {
    schemaVersion: 1,
    sourceRepository: config.sourceRepository,
    sourceRepositoryId: config.sourceRepositoryId,
    runId: 123,
    workflowHeadSHA: run.head_sha,
    headSHA: run.head_sha,
    validationOnly: false,
    tag: "v0.11.3",
    version: "0.11.3",
    platform,
    architecture: platform === "darwin" ? "arm64" : "x64",
    electronVersion: config.electronVersion,
    nativeValidated: true,
    artifacts: [{ filename, size: bytes.length, sha256: sha256(bytes) }],
  };
}
test("only successful runs from the intended private release workflow are eligible", () => {
  validateRun(run, config);
  validateRun({ ...run, event: "workflow_dispatch", head_branch: "main" }, config);
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { event: "pull_request" },
    { event: "workflow_dispatch", head_branch: "agent/unreviewed-workflow" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/other.yml" },
    { repository: { id: 1, full_name: config.sourceRepository } },
  ])
    assert.throws(() => validateRun({ ...run, ...patch }, config));
});
test("build validation rejects preview-only provenance, changed bytes, extra source files and traversal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "servlet-bridge-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = bundle("darwin", "Servlet-0.11.3-unsigned-arm64.zip");
  fs.writeFileSync(
    path.join(root, b.artifacts[0].filename),
    "compiled-test-fixture",
  );
  fs.writeFileSync(path.join(root, "bundle.json"), JSON.stringify(b));
  validateBundle(b, run, config, "darwin", root);
  for (const patch of [
    { validationOnly: true },
    { nativeValidated: false },
    { runId: 124 },
    { workflowHeadSHA: "b".repeat(40) },
    { headSHA: "b".repeat(40) },
  ])
    assert.throws(() =>
      validateBundle({ ...b, ...patch }, run, config, "darwin", root),
    );
  fs.writeFileSync(path.join(root, b.artifacts[0].filename), "tampered");
  assert.throws(
    () => validateBundle(b, run, config, "darwin", root),
    /checksum/,
  );
  fs.writeFileSync(
    path.join(root, b.artifacts[0].filename),
    "compiled-test-fixture",
  );
  fs.writeFileSync(path.join(root, "private-source.js"), "private");
  assert.throws(
    () => validateBundle(b, run, config, "darwin", root),
    /unexpected files/,
  );
  assert.throws(() =>
    validateBundle(
      {
        ...b,
        artifacts: [{ ...b.artifacts[0], filename: "../../secret.key" }],
      },
      run,
      config,
      "darwin",
      root,
    ),
  );
});
test("platform builds share a source commit; Windows stays withheld while signed Mac and Linux are published", () => {
  const builds = [
    bundle("darwin", "Servlet-0.11.3-unsigned-arm64.zip"),
    bundle("linux", "Servlet-0.11.3-linux-x64.deb"),
    bundle("win32", "Servlet-0.11.3-win-x64.exe"),
  ];
  matchBundles(builds);
  assert.throws(() =>
    matchBundles([
      builds[0],
      { ...builds[1], headSHA: "b".repeat(40) },
      builds[2],
    ]),
  );
  const mac = {
    available: true,
    notarized: true,
    teamId: config.appleTeamId,
    version: "0.11.3",
    notarization: { app: "accepted-fixture", dmg: "accepted-fixture" },
    zipSHA256: "a".repeat(64),
    zipSize: 1,
  };
  const manifest = releaseManifest(config, builds, mac);
  assert.equal(
    manifest.releases.find((r) => r.platform === "win32").available,
    false,
  );
  assert.equal(
    manifest.releases.find((r) => r.platform === "linux").available,
    true,
  );
  assert.match(
    manifest.releases[0].zipURL,
    /github.com\/hgoudat\/servlet-releases\/releases\/download\/v0.11.3\//,
  );
  assert.throws(() =>
    releaseManifest(config, builds, { ...mac, notarized: false }),
  );
});
test("private artifact credentials are never forwarded to storage redirects", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "servlet-transport-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const bytes = Buffer.from("archive-fixture");
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://build.blob.core.windows.net/artifact?sig=temporary",
          },
        })
      : new Response(bytes);
  };
  await downloadArtifact(
    config.sourceRepository,
    { id: 1, size_in_bytes: bytes.length, digest: "sha256:" + sha256(bytes) },
    "fixture-private-token",
    path.join(root, "input.zip"),
    fetch,
  );
  assert.equal(
    calls[0].options.headers.authorization,
    "Bearer fixture-private-token",
  );
  assert.equal(calls[1].options.headers, undefined);
  await assert.rejects(
    downloadArtifact(
      config.sourceRepository,
      { id: 1, size_in_bytes: 1 },
      "fixture",
      path.join(root, "bad.zip"),
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/artifact" },
        }),
    ),
    /Untrusted/,
  );
});
test("public download verification rejects changed files and foreign redirects", async () => {
  const bytes = Buffer.from("signed-fixture");
  const expected = { size: bytes.length, sha256: sha256(bytes) };
  await verifyPublic(
    "https://github.com/release.zip",
    expected,
    async () => new Response(bytes),
  );
  await assert.rejects(
    verifyPublic(
      "https://github.com/release.zip",
      expected,
      async () => new Response("tampered"),
    ),
    /mismatch/,
  );
  await assert.rejects(
    verifyPublic(
      "https://github.com/release.zip",
      expected,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://attacker.invalid/file" },
        }),
    ),
    /Untrusted/,
  );
});
