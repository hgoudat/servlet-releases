import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { signAsync } from "@electron/osx-sign";
import { extractFile } from "@electron/asar";
import {
  checkSigningIdentity,
  notarizeArchive,
  stapleAndValidate,
  validateStapledTicket,
} from "./apple-notarization.mjs";
import { sha256 } from "./bundles.mjs";
const config = JSON.parse(fs.readFileSync("bridge-config.json"));
const bundle = JSON.parse(fs.readFileSync("staging/darwin/bundle.json"));
const cert = process.env.SERVLET_SIGNING_IDENTITY,
  profile = process.env.SERVLET_NOTARY_PROFILE;
const identities = execFileSync(
  "security",
  ["find-identity", "-v", "-p", "codesigning"],
  { encoding: "utf8" },
);
checkSigningIdentity(identities, cert, config.appleTeamId);
const out = path.resolve("release/public");
fs.mkdirSync(out, { recursive: true });
const unpacked = path.resolve("release/app");
fs.mkdirSync(unpacked, { recursive: true });
execFileSync("python3", [
  "scripts/safe-unzip.py",
  path.resolve("staging/darwin", bundle.artifacts[0].filename),
  unpacked,
  "app",
]);
const app = path.join(unpacked, "Servlet.app");
for (const [key, value] of [
  ["CFBundleIdentifier", "com.servlet.desktop"],
  ["CFBundleShortVersionString", bundle.version],
]) {
  const actual = execFileSync(
    "plutil",
    ["-extract", key, "raw", "-o", "-", path.join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  if (actual !== value)
    throw Error("Unexpected application bundle identity or version.");
}
const pin = JSON.parse(
  extractFile(
    path.join(app, "Contents/Resources/app.asar"),
    "electron/release-config.json",
  ).toString(),
);
if (pin.teamId !== config.appleTeamId)
  throw Error("The application updater has an unexpected signing-team pin.");
await signAsync({
  app,
  identity: cert,
  type: "distribution",
  platform: "darwin",
  preAutoEntitlements: false,
  optionsForFile: () => ({
    entitlements: path.resolve("build/entitlements.mac.plist"),
    hardenedRuntime: true,
  }),
});
execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
const submit = path.resolve("release/submission.zip");
execFileSync("ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  app,
  submit,
]);
const appResult = notarizeArchive(
  submit,
  profile,
  path.resolve("release/notarization"),
);
await stapleAndValidate(app);
const pkg = JSON.parse(fs.readFileSync("package.json"));
pkg.version = bundle.version;
fs.writeFileSync("package.json", JSON.stringify(pkg));
execFileSync(
  "node_modules/.bin/electron-builder",
  [
    "--config",
    "build/mac.json",
    "--mac",
    "--arm64",
    "--prepackaged",
    app,
    "--publish",
    "never",
    `-c.extraMetadata.version=${bundle.version}`,
  ],
  { stdio: "inherit" },
);
const dmg = path.join(out, `Servlet-${bundle.version}-arm64.dmg`),
  zip = path.join(out, `Servlet-${bundle.version}-arm64.zip`);
const ticket = execFileSync("unzip", [
  "-p",
  zip,
  "Servlet.app/Contents/CodeResources",
]);
if (!ticket.equals(fs.readFileSync(path.join(app, "Contents/CodeResources"))))
  throw Error("Installer ZIP is missing the stapled app ticket.");
execFileSync("codesign", ["--force", "--sign", cert, "--timestamp", dmg]);
execFileSync("codesign", ["--verify", "--strict", dmg]);
const dmgResult = notarizeArchive(
  dmg,
  profile,
  path.resolve("release/notarization"),
);
await stapleAndValidate(dmg);
execFileSync("spctl", ["--assess", "--type", "execute", app]);
execFileSync("spctl", [
  "--assess",
  "--type",
  "open",
  "--context",
  "context:primary-signature",
  dmg,
]);
const checkDir = fs.mkdtempSync(path.resolve("release", "installer-check-"));
const mount = path.join(checkDir, "mounted");
fs.mkdirSync(mount);
try {
  execFileSync("hdiutil", [
    "attach",
    dmg,
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
  ]);
  try {
    execFileSync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      path.join(mount, "Servlet.app"),
    ]);
    execFileSync("spctl", [
      "--assess",
      "--type",
      "execute",
      path.join(mount, "Servlet.app"),
    ]);
    await validateStapledTicket(path.join(mount, "Servlet.app"));
  } finally {
    execFileSync("hdiutil", ["detach", mount]);
  }
} finally {
  fs.rmSync(checkDir, { recursive: true, force: true });
}
fs.writeFileSync(
  path.join(out, "mac.json"),
  JSON.stringify(
    {
      available: true,
      version: bundle.version,
      architecture: "arm64",
      minimumMacOS: "13",
      notarized: true,
      teamId: config.appleTeamId,
      notarization: { app: appResult.id, dmg: dmgResult.id },
      zipSHA256: sha256(fs.readFileSync(zip)),
      zipSize: fs.statSync(zip).size,
      dmgSHA256: sha256(fs.readFileSync(dmg)),
      dmgSize: fs.statSync(dmg).size,
    },
    null,
    2,
  ) + "\n",
);
