import { test } from "node:test";
import assert from "node:assert/strict";
import { pressureAlertCopy, TEST_ALERT_COPY } from "../lib/alert-copy.ts";

for (const [metric, name, threshold] of [["cpu", "CPU", 95], ["memory", "Memory", 90]]) {
  test(`${name} alert uses a plain title and an inclusive threshold`, () => {
    assert.deepEqual(pressureAlertCopy({ metric, type: "incident", threshold, value: 99 }), {
      title: `High ${metric === "cpu" ? "CPU" : "memory"} usage`,
      description: `${name} usage stayed at ${threshold}% or higher for at least one minute.`,
    });
  });
  test(`${name} recovery describes the recorded value, not a live reading`, () => {
    assert.deepEqual(pressureAlertCopy({ metric, type: "recovery", threshold, value: 40 }), {
      title: `${name} usage back to normal`, description: `${name} usage dropped to 40%.`,
    });
    assert.equal(pressureAlertCopy({ metric, type: "recovery", threshold, value: 40.26 }).description, `${name} usage dropped to 40.3%.`);
  });
}

test("test copy clearly identifies a preview without inventing a CPU reading", () => {
  assert.deepEqual(TEST_ALERT_COPY, { title: "Test notification", description: "This is a preview. No overload was triggered." });
});
