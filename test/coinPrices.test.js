// Twinkle.coins in the CLI (review fixes L6 and M6, 11-07): rewards check and
// admin review show every price with where all its Coins go, builder payments
// included, and refund wording never hides who covers a refund.
import test from "node:test";
import assert from "node:assert/strict";
import { formatCoinPrices, coinPriceDestination } from "../lib/rewards.js";
import { printRewardReviewResult } from "../lib/admin.js";
import { formatCoinsResult } from "../lib/admin-coins.js";

const claim = {
  id: "claim-plot", title: "Claim built land", coins: 0, destination: "removed", uniqueKey: true, keyGroup: "plots",
  builders: { coinsPerUnit: 50, maxUnitsPerRecipient: 4096, maxRecipients: 64, maxCoinsPerPurchase: 100000, unitName: "block", topic: "blocks" },
};
const land = { id: "land-plot", title: "Extra land plot", coins: 500, destination: "removed", uniqueKey: true, keyGroup: "plots", offers: { minCoins: 100, maxCoins: 5000 } };

test("a builders price never prints as only \"Coins removed\"", () => {
  const lines = formatCoinPrices({ prices: [claim, land], spendBudget: { userDailyCoins: 5000 } });
  const claimLine = lines.find((line) => line.includes("claim-plot"));
  // Round-2 N7: a 0-Coin builders price is not "free".
  assert.match(claimLine, /0 Coins of its own \+ 50 Coins per block paid to builders the app names/);
  assert.match(claimLine, /up to 4096 each, 64 builders, 100000 Coins a purchase/);
  assert.match(claimLine, /topic "blocks"/);
  assert.match(claimLine, /key group plots/);
  assert.match(claimLine, /no offers on items bought with this price/);
  const landLine = lines.find((line) => line.includes("land-plot"));
  assert.match(landLine, /500 Coins removed/);
  assert.match(landLine, /1 open per player/);
  // Round-2 N2/N3: the highest offer price and who a resale pays.
  assert.match(landLine, /offers from 100 to 5000 Coins, each Sell or takeover pays the previous holder \(a person: extra review\)/);
  assert.equal(coinPriceDestination({ ...land, destination: "owner" }), "500 Coins to the app owner (extra review)");
});

test("admin review show prints the prices and the server's coin warnings", () => {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    printRewardReviewResult({
      operation: { name: "reward-review.show" },
      data: { review: { id: 9, status: "pending", config: { rules: [], userDailyXP: 0, userDailyCoins: 0, prices: [claim] },
        coinPriceWarnings: ["“Claim built land” also pays players the app names (builders)."] } },
    });
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((line) => /claim-plot: Claim built land · 0 Coins of its own \+ 50 Coins per block paid to builders/.test(line)));
  assert.ok(lines.includes("WARNING: “Claim built land” also pays players the app names (builders)."));
});

test("a refund dry run says when the platform covers the Coins", () => {
  const [line] = formatCoinsResult({
    operation: { name: "coins.refund.preview" },
    data: { dryRun: true, receiptId: 4, refundCoins: 100, buyer: { username: "kid" }, takeBackFrom: [], platformCovers: 100 },
  });
  assert.match(line, /taking nothing back \(the platform covers 100 Coins\)/);
});
