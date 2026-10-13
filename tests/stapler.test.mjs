import test from "node:test";
import assert from "node:assert/strict";
import { stapleAndValidate, validateStapledTicket } from "../scripts/apple-notarization.mjs";

function failure(status, message = "Apple ticket response unavailable") {
  return Object.assign(Error("stapler failed"), {
    status,
    stdout: Buffer.from(message),
    stderr: Buffer.alloc(0),
  });
}

test("successful stapling still requires ticket validation", async () => {
  const actions = [];
  await stapleAndValidate("Servlet.app", {
    run: (command, args) => {
      assert.equal(command, "xcrun");
      actions.push(args[1]);
    },
  });
  assert.deepEqual(actions, ["staple", "validate"]);
});

test("ticket service failures retry validation without changing the staple", async () => {
  const actions = [], delays = [];
  let failures = 2;
  await stapleAndValidate("Servlet.app", {
    run: (_, args) => {
      actions.push(args[1]);
      if (args[1] === "validate" && failures-- > 0) throw failure(68);
    },
    retryDelays: [5, 15],
    wait: async (milliseconds) => delays.push(milliseconds),
    log: () => {},
  });
  assert.deepEqual(actions, ["staple", "validate", "validate", "validate"]);
  assert.deepEqual(delays, [5, 15]);
});

test("a transient staple failure can recover before validation", async () => {
  const actions = [];
  await stapleAndValidate("Servlet.app", {
    run: (_, args) => {
      actions.push(args[1]);
      if (actions.length === 1) throw failure(68);
    },
    retryDelays: [0],
    wait: async () => {},
    log: () => {},
  });
  assert.deepEqual(actions, ["staple", "staple", "validate"]);
});

test("invalid, missing and revoked tickets fail immediately", async () => {
  for (const status of [64, 65, 66, 77]) {
    let calls = 0;
    await assert.rejects(validateStapledTicket("Servlet.app", {
      run: () => { calls++; throw failure(status, "Ticket rejected"); },
      wait: async () => assert.fail("Permanent errors must not retry"),
    }), new RegExp(`exit ${status}.*\\nTicket rejected`));
    assert.equal(calls, 1);
  }
});

test("persistent service failures stop publication after bounded retries", async () => {
  let calls = 0;
  await assert.rejects(validateStapledTicket("Servlet.app", {
    run: () => { calls++; throw failure(68); },
    retryDelays: [0, 0],
    wait: async () => {},
    log: () => {},
  }), /exit 68.*\nApple ticket response unavailable/);
  assert.equal(calls, 3);
});
