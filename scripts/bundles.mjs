import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const versionOK = (v) =>
  typeof v === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export function newer(a, b) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}
export function validateRun(run, config) {
  if (
    !Number.isSafeInteger(run.id) ||
    run.repository?.id !== config.sourceRepositoryId ||
    run.repository?.full_name !== config.sourceRepository ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.path?.split("@")[0] !== `.github/workflows/${config.sourceWorkflow}` ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw Error("The private build run is not an eligible release candidate.");
  return run;
}
export function validateBundle(m, run, config, platform, folder) {
  const arch = platform === "darwin" ? "arm64" : "x64";
  if (
    m.schemaVersion !== 1 ||
    m.validationOnly !== false ||
    m.sourceRepository !== config.sourceRepository ||
    m.sourceRepositoryId !== config.sourceRepositoryId ||
    m.runId !== run.id ||
    m.workflowHeadSHA !== run.head_sha ||
    !/^[a-f0-9]{40}$/.test(m.headSHA) ||
    !versionOK(m.version) ||
    m.tag !== `v${m.version}` ||
    m.platform !== platform ||
    m.architecture !== arch ||
    m.electronVersion !== config.electronVersion ||
    m.nativeValidated !== true ||
    !Array.isArray(m.artifacts) ||
    !m.artifacts.length ||
    m.artifacts.length > 2
  )
    throw Error(
      "Build provenance or native validation does not match the approved run.",
    );
  const patterns = {
    darwin: new RegExp(
      `^Servlet-${m.version.replaceAll(".", "\\.")}-unsigned-arm64\\.zip$`,
    ),
    win32: new RegExp(
      `^Servlet-${m.version.replaceAll(".", "\\.")}-win-x64\\.exe$`,
    ),
    linux: new RegExp(
      `^Servlet-${m.version.replaceAll(".", "\\.")}-linux-x64\\.(deb|AppImage)$`,
    ),
  };
  for (const file of m.artifacts) {
    if (
      !patterns[platform]?.test(file.filename) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 512 * 1024 * 1024
    )
      throw Error("Unexpected staged artifact.");
    const location = path.join(folder, file.filename);
    if (
      !fs.lstatSync(location).isFile() ||
      fs.statSync(location).size !== file.size ||
      sha256(fs.readFileSync(location)) !== file.sha256
    )
      throw Error("Staged artifact checksum mismatch.");
  }
  const names = fs.readdirSync(folder);
  if (
    names.some(
      (name) =>
        name !== "bundle.json" &&
        !m.artifacts.some((file) => file.filename === name),
    )
  )
    throw Error("Private artifact contains unexpected files.");
  return m;
}
export function matchBundles(bundles) {
  const first = bundles[0];
  if (
    bundles.length !== 3 ||
    new Set(bundles.map((m) => m.platform)).size !== 3 ||
    bundles.some(
      (m) =>
        m.version !== first.version ||
        m.headSHA !== first.headSHA ||
        m.runId !== first.runId ||
        m.tag !== first.tag,
    )
  )
    throw Error("Desktop builds do not share one source version.");
  return first;
}
export function releaseManifest(
  config,
  bundles,
  mac,
  publishedAt = new Date().toISOString(),
) {
  const source = matchBundles(bundles),
    version = source.version;
  const root = `https://github.com/${config.distributionRepository}/releases/download/v${version}/`;
  if (
    mac.available !== true ||
    mac.notarized !== true ||
    mac.teamId !== config.appleTeamId ||
    mac.version !== version ||
    !mac.notarization?.app ||
    !mac.notarization?.dmg ||
    !/^[a-f0-9]{64}$/.test(mac.zipSHA256)
  )
    throw Error("Apple release evidence is incomplete.");
  const releases = [
    {
      ...mac,
      platform: "darwin",
      signed: true,
      validated: true,
      url: root + `Servlet-${version}-arm64.dmg`,
      zipURL: root + `Servlet-${version}-arm64.zip`,
      updateFeed: root + "updates.json",
      publishedAt,
    },
  ];
  const linux = bundles.find((m) => m.platform === "linux");
  for (const artifact of linux.artifacts)
    releases.push({
      platform: "linux",
      architecture: "x64",
      version,
      available: true,
      validated: true,
      signed: false,
      sha256: artifact.sha256,
      size: artifact.size,
      url: root + artifact.filename,
      publishedAt,
    });
  // Windows stays private until Artifact Signing is verified and implemented.
  releases.push({
    platform: "win32",
    architecture: "x64",
    version,
    available: false,
    validated: true,
    signed: false,
    message: "Windows signing is pending organization verification.",
  });
  return {
    schemaVersion: 1,
    source: {
      repository: config.sourceRepository,
      runId: source.runId,
      headSHA: source.headSHA,
    },
    releases,
  };
}
export function squirrelFeed(manifest) {
  const m = manifest.releases.find((r) => r.platform === "darwin");
  return {
    currentRelease: m.version,
    releases: [
      {
        version: m.version,
        updateTo: {
          version: m.version,
          url: m.zipURL,
          name: `Servlet ${m.version}`,
          pub_date: m.publishedAt,
          sha256: m.zipSHA256,
          size: m.zipSize,
        },
      },
    ],
  };
}
