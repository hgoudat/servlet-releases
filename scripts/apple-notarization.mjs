import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function checkSigningIdentity(identities, identity, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId || ""))
    throw Error(
      "Set SERVLET_APPLE_TEAM_ID to the ten-character Apple team ID.",
    );
  if (
    !identity?.startsWith("Developer ID Application:") ||
    !identity.endsWith(`(${teamId})`)
  )
    throw Error(
      "The Developer ID Application identity must match SERVLET_APPLE_TEAM_ID.",
    );
  if (
    !identities
      .split("\n")
      .some((line) => line.trim().endsWith(`\"${identity}\"`))
  )
    throw Error(
      "The requested valid signing identity is not installed with its private key.",
    );
}

export function checkNotaryResult(result) {
  if (
    result?.status !== "Accepted" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      result.id || "",
    )
  )
    throw Error(
      `Apple did not accept this submission (${result?.status || "missing status"}).`,
    );
  return result;
}

export function notarizeArchive(
  file,
  profile,
  evidenceDir,
  run = execFileSync,
) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const stem = path.basename(file);
  let output, failure;
  try {
    output = run(
      "xcrun",
      [
        "notarytool",
        "submit",
        file,
        "--keychain-profile",
        profile,
        "--wait",
        "--output-format",
        "json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    failure = error;
    output = error.stdout?.toString() || "";
  }
  fs.writeFileSync(path.join(evidenceDir, `${stem}.submission.json`), output, {
    mode: 0o600,
  });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw Error(
      `Apple returned no usable submission result. See private evidence in ${evidenceDir}.`,
    );
  }
  if (/^[0-9a-f-]{36}$/i.test(result.id || "")) {
    try {
      run(
        "xcrun",
        [
          "notarytool",
          "log",
          result.id,
          "--keychain-profile",
          profile,
          path.join(evidenceDir, `${stem}.log.json`),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      fs.chmodSync(path.join(evidenceDir, `${stem}.log.json`), 0o600);
    } catch {
      // The submission result remains usable when Apple's log endpoint is unavailable.
    }
  }
  checkNotaryResult(result);
  if (failure)
    throw Error(
      "notarytool failed despite reporting Accepted; release stopped.",
    );
  console.log(`Apple accepted ${stem}: ${result.id}`);
  return result;
}
