// Counts "unexpected money" scam patterns in a local Reddit dump (Arctic Shift export).
// Publishes counts and links only: post text is not ours to republish.
//
//   node scripts/pattern-scan.ts <posts.json> [--samples]
// Input: [{ sub, id, t: title, x: selftext, s: score, c: comments, u: created_utc }]
import { readFileSync } from "node:fs";

type Post = { sub: string; id: string; t: string; x: string; s: number; c: number; u: number };

// Receiving side only: someone sent *me* money I didn't expect.
const RECEIVED = /\b(received|receiving|got|getting|was sent|been sent|sent me|someone sent|somebody sent|deposited into my|showed up in my|landed in my|paid me|payment from)\b/i;
const UNEXPECTED = /\b(random(ly)?|unknown|stranger|someone i (don'?t|do not) know|(a )?person i (don'?t|do not) know|never (met|heard of)|no idea who|by (mistake|accident)|accidental(ly)?|mistakenly|wrong (person|account|email|recipient)|unexpected(ly)?|out of (nowhere|the blue))\b/i;
const MONEY = /(\$|£|€)\s?\d|\b\d+ ?(dollars|usd|bucks)\b|\b(money|payment|funds)\b/i;
// Sending-side mishaps ("I accidentally sent...") are a different problem.
const SENDER_SIDE = /\bi (accidentally|mistakenly) (sent|paid|transferred|withdrew)|\b(i|my \w+) sent [^.]{0,30}to the wrong\b/i;
const IN_SCOPE = new Set(["paypal", "venmo", "Scams", "Etsy", "ebay", "EtsySellers", "Flipping", "smallbusiness", "personalfinance", "CreditCards", "sidehustle", "shopify", "ecommerce"]);

export const PATTERNS: [string, string, RegExp][] = [
  ["asks_back", "Sender asks for the money back", /\b(send|give|pay|return|refund)\b[^.?!]{0,40}\b(it |the money )?back\b|\b(asked|asking|wants?) (me )?(to )?(return|refund|send)\b/i],
  ["other_channel", "Wants it back through another app, account or card", /\b(cash ?app|zelle|venmo|gift ?cards?|bitcoin|crypto|other account|different account|another account|friends (and|&) family)\b/i],
  ["avoid_refund", "Tells you not to use the refund button", /\b(don'?t|do not|not to) (use |click )?(the )?refund\b|\brefund (button|option)[^.]{0,30}\b(won'?t|doesn'?t|not)\b/i],
  ["overpayment", "Buyer overpays an order", /\b(overpa(id|y|yment)|paid (me )?(too much|extra|more than)|extra (money|amount|\$))\b/i],
  ["third_party", "Asks you to pay a shipper, agent or friend", /\b(shipp(er|ing agent)|courier|mover|pick ?up (agent|person)|my agent)\b/i],
  ["reversed", "Original payment later reversed or disputed", /\b(revers(ed|al)|chargeback|charged back|disputed|negative balance|clawed back|unauthori[sz]ed)\b/i],
  ["settlement", "Real settlement or payout that looked like a scam", /\b(settlement|class action|ftc|claim (payment|number)|rebate)\b/i],
  ["hacked_source", "Money came from a hacked or stolen account or card", /\b(hacked|stolen (card|account|credit card)|compromised)\b/i],
];

if (import.meta.main) {
  const [file, flag] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node scripts/pattern-scan.ts <posts.json> [--samples]");
    process.exit(1);
  }
  const posts = (JSON.parse(readFileSync(file, "utf8")) as Post[]).filter((p) => IN_SCOPE.has(p.sub));
  const hits = posts.filter((p) => {
    const text = `${p.t}\n${p.x}`;
    return RECEIVED.test(text) && UNEXPECTED.test(text) && MONEY.test(text) && !SENDER_SIDE.test(text);
  });
  const first = new Date(Math.min(...posts.map((p) => p.u)) * 1000).toISOString().slice(0, 10);
  const last = new Date(Math.max(...posts.map((p) => p.u)) * 1000).toISOString().slice(0, 10);
  console.log(`Scanned ${posts.length} posts from ${IN_SCOPE.size} subreddits, ${first} to ${last}.`);
  console.log(`Unexpected-money posts: ${hits.length} (${hits.reduce((n, p) => n + p.c, 0)} comments)\n`);
  for (const [code, label, re] of PATTERNS) {
    const m = hits.filter((p) => re.test(`${p.t}\n${p.x}`)).sort((a, b) => b.c - a.c);
    console.log(`${code}\t${m.length}\t${label}\t${m.slice(0, 3).map((p) => `https://www.reddit.com/comments/${p.id}`).join(" ")}`);
  }
  const bySub = new Map<string, number>();
  for (const p of hits) bySub.set(p.sub, (bySub.get(p.sub) ?? 0) + 1);
  console.log(`\nBy subreddit: ${[...bySub].sort((a, b) => b[1] - a[1]).map(([s, n]) => `r/${s} ${n}`).join(", ")}`);
  if (flag === "--all") for (const p of hits) console.log(`${p.id} [${p.sub}] ${p.t.slice(0, 90)} :: ${p.x.slice(0, 110).replace(/\s+/g, " ")}`);
  // Every 4th hit, for a hand check of precision.
  if (flag === "--samples") for (const p of hits.filter((_, i) => i % 4 === 0).slice(0, 50)) console.log(`\n${p.id} [${p.sub}] ${p.t} :: ${p.x.slice(0, 220).replace(/\s+/g, " ")}`);
}
