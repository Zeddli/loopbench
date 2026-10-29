import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allowanceMicros,
  preferredCredential,
  preserveSelection,
} from "../components/hosted/contracts";

test("inference allowance requires explicit bounded decimal dollars", () => {
  assert.equal(allowanceMicros("0.20"), "200000");
  assert.equal(allowanceMicros("0.50"), "500000");
  for (const value of ["5", "0", "-1", "0.500001", "NaN", "2e-1"])
    assert.equal(allowanceMicros(value), null);
});

test("a failed new connection cannot hide an older verified credential", () => {
  const verified = { id: "working", status: "verified" };
  assert.equal(
    preferredCredential([
      { id: "new-invalid", status: "invalid" },
      { id: "temporary-outage", status: "unavailable" },
      verified,
    ]),
    verified,
  );
  assert.equal(
    preferredCredential([
      { id: "revoked", status: "revoked" },
      { id: "invalid", status: "invalid" },
    ]),
    undefined,
  );
});

test("an interrupted credential check can be retried when none is verified", () => {
  const retryable = { id: "outage", status: "unavailable" };
  assert.equal(
    preferredCredential([{ id: "invalid", status: "invalid" }, retryable]),
    retryable,
  );
  const unverified = { id: "interrupted", status: "unverified" };
  assert.equal(preferredCredential([unverified]), unverified);
});

test("poll refresh preserves an existing selected real node", () => {
  assert.equal(preserveSelection("old", ["new", "old"]), "old");
  assert.equal(preserveSelection("gone", ["root", "head"]), "head");
  assert.equal(preserveSelection("gone", []), "");
});
