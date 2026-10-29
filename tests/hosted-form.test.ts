import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allowanceMicros,
  preserveSelection,
} from "../components/hosted/contracts";

test("inference allowance requires explicit bounded decimal dollars", () => {
  assert.equal(allowanceMicros("0.20"), "200000");
  assert.equal(allowanceMicros("0.50"), "500000");
  for (const value of ["5", "0", "-1", "0.500001", "NaN", "2e-1"])
    assert.equal(allowanceMicros(value), null);
});

test("poll refresh preserves an existing selected real node", () => {
  assert.equal(preserveSelection("old", ["new", "old"]), "old");
  assert.equal(preserveSelection("gone", ["root", "head"]), "head");
  assert.equal(preserveSelection("gone", []), "");
});
