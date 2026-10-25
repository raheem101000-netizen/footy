import assert from "assert";
import { pickRegion } from "../src/regions";

// Typical round-trip times (ms) from each city to Render's US regions.
const SEATTLE = { oregon: 20, ohio: 60, virginia: 70 };
const BOSTON = { oregon: 80, ohio: 30, virginia: 15 };
const NEW_YORK = { oregon: 75, ohio: 25, virginia: 8 };
const LOS_ANGELES = { oregon: 25, ohio: 55, virginia: 65 };
const REGIONS = ["oregon", "ohio", "virginia"];

describe("pickRegion — the fair pick", () => {
  it("Seattle vs Boston → Ohio (fair to both, not best for one)", () => {
    assert.strictEqual(pickRegion(SEATTLE, BOSTON, SEATTLE, REGIONS, "oregon").region, "ohio");
    assert.strictEqual(pickRegion(BOSTON, SEATTLE, BOSTON, REGIONS, "oregon").region, "ohio");   // order doesn't matter
  });

  it("New York vs Boston → Virginia", () => {
    assert.strictEqual(pickRegion(NEW_YORK, BOSTON, NEW_YORK, REGIONS, "oregon").region, "virginia");
  });

  it("LA vs LA → Oregon", () => {
    assert.strictEqual(pickRegion(LOS_ANGELES, { ...LOS_ANGELES, oregon: 30 }, LOS_ANGELES, REGIONS, "ohio").region, "oregon");
  });

  it("score = max + |gap|/2: a fair region beats one great for one player only", () => {
    // oregon: max 100 + 45 = 145; ohio: 50 + 0 = 50
    const pick = pickRegion({ oregon: 10, ohio: 50 }, { oregon: 100, ohio: 50 }, undefined, ["oregon", "ohio"], "oregon");
    assert.deepStrictEqual(pick, { region: "ohio", why: "fair", score: 50 });
  });

  it("only regions BOTH players measured count", () => {
    const pick = pickRegion({ oregon: 5, ohio: 40 }, { ohio: 40 }, undefined, REGIONS, "virginia");
    assert.strictEqual(pick.region, "ohio");
  });

  it("no region in common → the host's best region", () => {
    const pick = pickRegion({ oregon: 30 }, { virginia: 20 }, { oregon: 30, ohio: 80 }, REGIONS, "virginia");
    assert.deepStrictEqual(pick, { region: "oregon", why: "host-best" });
  });

  it("no pings at all → home", () => {
    assert.deepStrictEqual(pickRegion(undefined, undefined, undefined, REGIONS, "ohio"), { region: "ohio", why: "home" });
  });

  it("never picks a region that isn't configured", () => {
    const pick = pickRegion({ tokyo: 1 }, { tokyo: 1 }, { tokyo: 1 }, REGIONS, "oregon");
    assert.deepStrictEqual(pick, { region: "oregon", why: "home" });
  });

  it("ties: lower total, then home", () => {
    // same score 60 in both (oregon 50 + 20/2, ohio 60 + 0); oregon total 80 < ohio total 120
    assert.strictEqual(pickRegion({ oregon: 30, ohio: 60 }, { oregon: 50, ohio: 60 }, undefined, ["ohio", "oregon"], "ohio").region, "oregon");
    // identical everywhere → home
    assert.strictEqual(pickRegion({ oregon: 30, ohio: 30 }, { oregon: 30, ohio: 30 }, undefined, ["oregon", "ohio"], "ohio").region, "ohio");
  });
});
