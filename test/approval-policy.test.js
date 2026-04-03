import test from "node:test";
import assert from "node:assert/strict";

import { isApprovalEnabled, requiresApproval } from "../lib/approval-policy.js";

test("approval disabled by default", () => {
  assert.equal(isApprovalEnabled({}), false);
});

test("risky prompt requires approval", () => {
  assert.equal(requiresApproval("Please fix the bug and run tests", {}), true);
});

test("safe prompt does not require approval", () => {
  assert.equal(requiresApproval("Explain this stack trace only", {}), false);
});

test("custom patterns override defaults", () => {
  const cfg = {
    approval: {
      riskHeuristics: ["dangerous_action"],
    },
  };
  assert.equal(requiresApproval("fix the file", cfg), false);
  assert.equal(requiresApproval("run dangerous_action now", cfg), true);
});
