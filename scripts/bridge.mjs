import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { api, downloadArtifact, verifyPublic } from "./github.mjs";
import {
  validateRun,
  validateBundle,
  matchBundles,
  releaseManifest,
  squirrelFeed,
  sha256,
  newer,
} from "./bundles.mjs";
const config = JSON.parse(fs.readFileSync("bridge-config.json"));
const sourceToken = process.env.PRIVATE_ARTIFACT_READ_TOKEN;
const own = (route, options = {}) =>
  api(`repos/${config.distributionRepository}/${route}`, options);
const source = (route) =>
  api(`repos/${config.sourceRepository}/${route}`, { token: sourceToken });
const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};
function release(tag) {
  try {
    return own(`releases/tags/${tag}`);
  } catch (error) {
    if (error.stderr?.toString().includes("404")) return null;
    throw Error("Cannot read the existing public release.");
  }
}
async function fetchRun(id) {
  if (!sourceToken)
    throw Error(
      "Configure the read-only private Actions artifact token in this repository.",
    );
  const run = validateRun(source(`actions/runs/${id}`), config);
  const list = source(`actions/runs/${id}/artifacts?per_page=100`).artifacts;
  const staging = path.resolve("staging");
  fs.mkdirSync(staging, { recursive: true });
  const bundles = [];
  for (const platform of ["darwin", "linux", "win32"]) {
    const matches = list.filter(
      (a) => a.name === `servlet-release-${platform}`,
    );
    if (matches.length !== 1)
      throw Error("A required release artifact is missing or duplicated.");
    const archive = path.join(staging, `${platform}.zip`),
      folder = path.join(staging, platform);
    await downloadArtifact(
      config.sourceRepository,
      matches[0],
      sourceToken,
      archive,
    );
    execFileSync("python3", ["scripts/safe-unzip.py", archive, folder]);
    bundles.push(
      validateBundle(
        JSON.parse(fs.readFileSync(path.join(folder, "bundle.json"))),
        run,
        config,
        platform,
        folder,
      ),
    );
  }
  const first = matchBundles(bundles);
  fs.writeFileSync(
    path.join(staging, "candidate.json"),
    JSON.stringify({ run, bundles }, null, 2) + "\n",
  );
  return first;
}
async function discover() {
  if (!sourceToken)
    throw Error(
      "Configure PRIVATE_ARTIFACT_READ_TOKEN with only private repository Actions read access.",
    );
  const explicit = process.env.PRIVATE_RUN_ID;
  const runs = explicit
    ? [source(`actions/runs/${explicit}`)]
    : source(
        `actions/workflows/${config.sourceWorkflow}/runs?status=success&per_page=20`,
      ).workflow_runs;
  for (const run of runs) {
    try {
      validateRun(run, config);
    } catch {
      if (explicit)
        throw Error(
          "Requested run is not an eligible completed release build.",
        );
      continue;
    }
    const artifacts = source(
      `actions/runs/${run.id}/artifacts?per_page=100`,
    ).artifacts;
    if (
      !["darwin", "linux", "win32"].every((p) =>
        artifacts.some((a) => a.name === `servlet-release-${p}` && !a.expired),
      )
    )
      continue;
    const candidate = await fetchRun(run.id);
    const existing = release(candidate.tag);
    if (existing && !existing.draft) {
      output("needed", "false");
      return;
    }
    output("needed", "true");
    output("run_id", run.id);
    output("version", candidate.version);
    output("head_sha", candidate.headSHA);
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Release candidate ${candidate.tag}\n\nPrivate build: https://github.com/${config.sourceRepository}/actions/runs/${run.id}\n\nSource commit: \`${candidate.headSHA}\`\n\nMac and Linux downloads will be published after release approval and notarization. Windows remains withheld until signing is ready.\n`,
      );
    return;
  }
  output("needed", "false");
}
function currentPointer() {
  const file = own("contents/release.json?ref=feeds");
  const manifest = JSON.parse(
    Buffer.from(file.content.replaceAll("\n", ""), "base64").toString(),
  );
  const versions =
    manifest.releases?.filter((r) => r.available).map((r) => r.version) || [];
  return { file, manifest, versions };
}
async function publish() {
  const { run, bundles } = JSON.parse(
    fs.readFileSync("staging/candidate.json"),
  );
  validateRun(run, config);
  for (const b of bundles)
    validateBundle(
      b,
      run,
      config,
      b.platform,
      path.resolve("staging", b.platform),
    );
  const candidate = matchBundles(bundles),
    tag = candidate.tag;
  const previous = currentPointer();
  if (previous.versions.some((v) => newer(v, candidate.version)))
    throw Error("Refusing to publish an older desktop release.");
  let existing = release(tag);
  const out = path.resolve("release/public");
  fs.mkdirSync(out, { recursive: true });
  if (!existing?.draft && existing) {
    // A prior run may have published an immutable release but failed to promote.
    // Recover its original metadata instead of rebuilding or replacing assets.
    if (existing.immutable !== true)
      throw Error("Existing release is not immutable.");
    execFileSync(
      "gh",
      [
        "release",
        "download",
        tag,
        "--repo",
        config.distributionRepository,
        "--pattern",
        "release.json",
        "--dir",
        path.join(out, "recover"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(out, "recover/release.json")),
    );
    if (
      saved.source?.runId !== candidate.runId ||
      saved.source?.headSHA !== candidate.headSHA
    )
      throw Error("Published version belongs to a different source build.");
    await promote(saved, previous);
    return;
  }
  const mac = JSON.parse(fs.readFileSync(path.join(out, "mac.json")));
  const manifest = releaseManifest(config, bundles, mac);
  const files = [
    `Servlet-${candidate.version}-arm64.dmg`,
    `Servlet-${candidate.version}-arm64.zip`,
  ];
  for (const artifact of bundles.find((b) => b.platform === "linux")
    .artifacts) {
    fs.copyFileSync(
      path.join("staging/linux", artifact.filename),
      path.join(out, artifact.filename),
    );
    files.push(artifact.filename);
  }
  fs.writeFileSync(
    path.join(out, "updates.json"),
    JSON.stringify(squirrelFeed(manifest)) + "\n",
  );
  fs.writeFileSync(
    path.join(out, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const records = files.map((name) => ({
    name,
    size: fs.statSync(path.join(out, name)).size,
    sha256: sha256(fs.readFileSync(path.join(out, name))),
  }));
  fs.writeFileSync(
    path.join(out, "SHA256SUMS"),
    records.map((r) => `${r.sha256}  ${r.name}`).join("\n") + "\n",
  );
  const body = {
    tag_name: tag,
    target_commitish: process.env.GITHUB_SHA,
    name: `Servlet ${candidate.version}`,
    draft: true,
    body: `macOS: Developer ID signed and notarized. Linux: validated .deb and AppImage. Windows signing is pending; no Windows installer is published.\n\nSource build ${candidate.runId}, commit ${candidate.headSHA}.`,
  };
  if (!existing) existing = own("releases", { method: "POST", body });
  execFileSync(
    "gh",
    [
      "release",
      "upload",
      tag,
      "--repo",
      config.distributionRepository,
      ...[...files, "updates.json", "release.json", "SHA256SUMS"].map((name) =>
        path.join(out, name),
      ),
      "--clobber",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const published = own(`releases/${existing.id}`, {
    method: "PATCH",
    body: { draft: false, make_latest: "true" },
  });
  if (published.immutable !== true)
    throw Error("Release immutability must be enabled before feed promotion.");
  for (const record of records)
    await verifyPublic(
      `https://github.com/${config.distributionRepository}/releases/download/${tag}/${record.name}`,
      record,
    );
  for (const name of ["updates.json", "release.json", "SHA256SUMS"])
    await verifyPublic(
      `https://github.com/${config.distributionRepository}/releases/download/${tag}/${name}`,
      {
        size: fs.statSync(path.join(out, name)).size,
        sha256: sha256(fs.readFileSync(path.join(out, name))),
      },
    );
  await promote(manifest, previous);
}
async function promote(manifest, previous) {
  const current = currentPointer();
  if (current.file.sha !== previous.file.sha)
    throw Error("Release pointer changed during publication.");
  own("contents/release.json", {
    method: "PUT",
    body: {
      message: `Publish Servlet ${manifest.releases[0].version}`,
      content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n").toString(
        "base64",
      ),
      sha: current.file.sha,
      branch: "feeds",
    },
  });
  console.log("Verified release published; app update feed promoted.");
}
const command = process.argv[2];
if (command === "discover") await discover();
else if (command === "fetch") {
  if (!/^\d+$/.test(process.env.PRIVATE_RUN_ID || ""))
    throw Error("Provide a private release run ID.");
  const first = await fetchRun(Number(process.env.PRIVATE_RUN_ID));
  const previous = currentPointer();
  if (previous.versions.some((v) => newer(v, first.version)))
    throw Error("Refusing an older release candidate.");
  const existing = release(first.tag);
  output("already_published", existing && !existing.draft ? "true" : "false");
} else if (command === "publish") await publish();
else throw Error("Choose discover, fetch or publish.");
