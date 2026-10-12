import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
export function api(
  route,
  { token = process.env.GH_TOKEN, method = "GET", body } = {},
) {
  const args = [
    "api",
    route,
    "--method",
    method,
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
  ];
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token },
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return output.trim() ? JSON.parse(output) : null;
}
export async function downloadArtifact(
  repository,
  artifact,
  token,
  destination,
  fetchImpl = fetch,
) {
  if (artifact.expired || artifact.size_in_bytes > 750 * 1024 * 1024)
    throw Error("Build artifact is expired or oversized.");
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (response.status !== 302) throw Error("Private artifact download failed.");
  const target = new URL(response.headers.get("location"));
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !/\.blob\.core\.windows\.net$|\.actions\.githubusercontent\.com$/.test(
      target.hostname,
    )
  )
    throw Error("Untrusted artifact download redirect.");
  const data = await fetchImpl(target.href, {
    redirect: "error",
    signal: AbortSignal.timeout(300000),
  });
  if (!data.ok) throw Error("Artifact storage download failed.");
  const hash = createHash("sha256");
  const fd = fs.openSync(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of data.body) {
      bytes += chunk.length;
      if (bytes > 750 * 1024 * 1024)
        throw Error("Artifact exceeds its download limit.");
      hash.update(chunk);
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (artifact.digest && artifact.digest !== `sha256:${hash.digest("hex")}`)
    throw Error("GitHub artifact digest mismatch.");
}
export async function verifyPublic(url, expected, fetchImpl = fetch) {
  let response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(300000),
  });
  if (response.status === 302) {
    const target = new URL(response.headers.get("location"));
    if (
      target.protocol !== "https:" ||
      target.hostname !== "release-assets.githubusercontent.com" ||
      target.username ||
      target.password
    )
      throw Error("Untrusted release download redirect.");
    response = await fetchImpl(target.href, {
      redirect: "error",
      signal: AbortSignal.timeout(300000),
    });
  }
  if (!response.ok) throw Error("Published release download failed.");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > expected.size) throw Error("Published artifact size mismatch.");
    hash.update(chunk);
  }
  if (size !== expected.size || hash.digest("hex") !== expected.sha256)
    throw Error("Published artifact checksum mismatch.");
}
