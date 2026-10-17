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
test("Linux validation accepts native package names and rejects mismatched formats or architectures", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "servlet-linux-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filenames = [
    "Servlet-0.11.3-linux-amd64.deb",
    "Servlet-0.11.3-linux-x86_64.AppImage",
  ];
  const b = bundle("linux", filenames[0]);
  b.artifacts.push(bundle("linux", filenames[1]).artifacts[0]);
  for (const filename of filenames)
    fs.writeFileSync(path.join(root, filename), "compiled-test-fixture");
  fs.writeFileSync(path.join(root, "bundle.json"), JSON.stringify(b));
  validateBundle(b, run, config, "linux", root);
  for (const filename of [
    "Servlet-0.11.3-linux-x86_64.deb",
    "Servlet-0.11.3-linux-amd64.AppImage",
    "Servlet-0.11.3-linux-arm64.deb",
    "Servlet-0.11.4-linux-amd64.deb",
    "../Servlet-0.11.3-linux-amd64.deb",
  ])
    assert.throws(
      () => validateBundle({
        ...b,
        artifacts: [{ ...b.artifacts[0], filename }],
      }, run, config, "linux", root),
      /Unexpected staged artifact/,
    );
});
test("platform builds share a source commit; Windows stays withheld while signed Mac and Linux are published", () => {
  const builds = [
    bundle("darwin", "Servlet-0.11.3-unsigned-arm64.zip"),
    bundle("linux", "Servlet-0.11.3-linux-amd64.deb"),
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
  const windows = {
    version: "0.11.3",
    sha256: "b".repeat(64),
    size: 42,
    url: `${config.windowsReleaseBase}/0.11.3/Servlet-0.11.3-win-x64.exe`,
  };
  const signed = releaseManifest(config, builds, mac, undefined, windows);
  assert.deepEqual(
    (({ available, signed, sha256, size, url }) => ({ available, signed, sha256, size, url }))(
      signed.releases.find((r) => r.platform === "win32"),
    ),
    { available: true, signed: true, sha256: windows.sha256, size: 42, url: windows.url },
  );
  for (const bad of [
    { ...windows, version: "0.11.2" },
    { ...windows, url: "https://example.com/Servlet-0.11.3-win-x64.exe" },
    { ...windows, sha256: "nothex" },
    { ...windows, size: 0 },
  ])
    assert.throws(() => releaseManifest(config, builds, mac, undefined, bad));
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
