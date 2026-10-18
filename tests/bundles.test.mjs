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
test("a Windows installer published after the release is added to the feed without touching other entries", async () => {
  const { addWindows, needsWindows } = await import("../scripts/bundles.mjs");
  const builds = [
    bundle("darwin", "Servlet-0.11.3-unsigned-arm64.zip"),
    bundle("linux", "Servlet-0.11.3-linux-amd64.deb"),
    bundle("win32", "Servlet-0.11.3-win-x64.exe"),
  ];
  const mac = {
    available: true,
    notarized: true,
    teamId: config.appleTeamId,
    version: "0.11.3",
    notarization: { app: "accepted-fixture", dmg: "accepted-fixture" },
    zipSHA256: "a".repeat(64),
    zipSize: 1,
  };
  const published = releaseManifest(config, builds, mac, "2026-10-18T02:44:00Z");
  const windows = {
    version: "0.11.3",
    sha256: "c".repeat(64),
    size: 130796880,
    url: `${config.windowsReleaseBase}/0.11.3/Servlet-0.11.3-win-x64.exe`,
  };
  assert.equal(needsWindows(published, "0.11.3"), true);
  const updated = addWindows(published, config, windows, "2026-10-18T14:30:00Z");
  assert.equal(needsWindows(updated, "0.11.3"), false);
  const entry = updated.releases.find((r) => r.platform === "win32");
  assert.deepEqual(
    (({ available, signed, sha256, size, url, version }) => ({ available, signed, sha256, size, url, version }))(entry),
    { available: true, signed: true, sha256: windows.sha256, size: windows.size, url: windows.url, version: "0.11.3" },
  );
  // Mac, Linux and the source build are exactly what was published.
  assert.deepEqual(
    updated.releases.filter((r) => r.platform !== "win32"),
    published.releases.filter((r) => r.platform !== "win32"),
  );
  assert.deepEqual(updated.source, published.source);
  assert.equal(updated.releases.filter((r) => r.platform === "win32").length, 1);
  // Never overwrite a listed installer, and reject evidence for another version or location.
  assert.throws(() => addWindows(updated, config, windows), /already lists/);
  assert.throws(() => addWindows(published, config, { ...windows, version: "0.11.2" }), /incomplete/);
  assert.throws(() => addWindows(published, config, { ...windows, url: "https://example.com/x.exe" }), /incomplete/);
  assert.throws(() => addWindows({ ...published, releases: [...published.releases, { ...published.releases[0], version: "9.9.9" }] }, config, windows), /inconsistent/);
  // The published manifest itself is not modified.
  assert.equal(needsWindows(published, "0.11.3"), true);
});
test("scheduled discovery waits for an automated Windows build, but never forever", async () => {
  const { waitForWindows } = await import("../scripts/bundles.mjs");
  const now = Date.parse("2026-10-18T12:00:00Z");
  const base = { explicit: false, published: false, windowsReady: false, now };
  assert.equal(waitForWindows({ ...base, builtAt: "2026-10-18T11:30:00Z" }), true);
  assert.equal(waitForWindows({ ...base, builtAt: "2026-10-18T05:59:00Z" }), false, "gives up after six hours");
  assert.equal(waitForWindows({ ...base, windowsReady: true, builtAt: "2026-10-18T11:30:00Z" }), false);
  assert.equal(waitForWindows({ ...base, explicit: true, builtAt: "2026-10-18T11:30:00Z" }), false);
  assert.equal(waitForWindows({ ...base, published: true, builtAt: "2026-10-18T11:30:00Z" }), false);
  assert.equal(waitForWindows({ ...base, builtAt: undefined }), false, "unknown build time never blocks");
});
