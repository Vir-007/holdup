# Unexpected-money scam patterns

A small, open library of how the "I sent you money by mistake, send it back" scam shows up, built so other people can test their own scam checks against it.

## What's here

| File | What it is |
|---|---|
| `verified-posts.json` | 40 Reddit posts, each read by a person and confirmed to be about receiving money the poster didn't expect. Links, subreddit, date, comment count and pattern tags only: post text isn't ours to republish. |
| `testset.json` | 30 messages written by us that paraphrase those patterns (16 scams, 14 harmless). Hold Up's rules were tuned on this set. |
| `holdout.json` | 14 more messages written *after* the rules were tuned, never used to change them. |
| `../scripts/pattern-scan.ts` | The keyword filter that found candidate posts in a Reddit dump. |
| `../scripts/eval-patterns.ts` | Scores Hold Up against either test set. |

## How the posts were found

1. Downloaded 17,700 posts from 13 money-related subreddits (r/paypal, r/venmo, r/Scams, r/Etsy, r/ebay and others), 26 Mar to 26 Oct 2026, through the Arctic Shift API.
2. A keyword filter (receiving words + "random / stranger / by mistake" + money words, minus "I accidentally sent") found 170 candidates.
3. A person read every candidate and kept the 40 that really are about unexpected incoming money. Precision of the filter alone was therefore about 24%: keyword counts of this scam badly overstate it, which is why we only publish the hand-checked set.

## Patterns in the 40 posts

A post can have several tags. Counts are posts, not incidents.

| Pattern | Posts |
|---|---|
| Sender asks for the money back | 11 |
| Original payment later reversed, disputed or pulled back | 8 |
| A real settlement or reward payout that looked like a scam | 5 |
| Overpayment on a sale | 3 |
| Tiny "test" payment (£1, $0.15, $1) before something else | 3 |
| Person sent the money back and lost it | 3 |
| Account held or locked afterwards | 2 |

The same script turns up again and again: a payment with the note "inspection", then minutes later a request like "I sent you $300 by mistake!! Please send it back" (r/venmo, `1sfw741`). Five posts are the opposite problem, real FTC or class-action settlement payments that people ignored as scams, which is why Hold Up has a "known payout senders" list and never treats "unexpected" as "fraud" by itself.

## How Hold Up scores

"Caught" means flagged **high risk**. Every unmatched payment is at least medium risk, so a miss still shows a warning and the safe refund button; it just isn't the loudest warning.

| Set | Rules only | Rules + AI escalation |
|---|---|---|
| `testset.json` (tuned on) | 16/16 scams, 0/14 false alarms | 16/16 scams, 0–1/14 false alarms over 3 runs |
| `holdout.json` (not tuned on) | **4/7 scams, 0/7 false alarms** | **7/7 scams, 0/7 false alarms** over 2 runs |

Read these numbers with care:
- All messages are written by us. They test that Hold Up does what we say; they are not real-world accuracy.
- The held-out set is small (14 messages). The AI layer isn't deterministic, so we ran it several times and report the range.
- The AI layer can only *raise* a medium risk to high when it spots an unsafe way of returning money (another app or account, avoiding the refund button, paying a third party, or text aimed at the AI). It can never lower a risk, so a scammer who writes to the AI can only make Hold Up more careful.

Run it yourself:

```bash
npm run eval                          # rules, tuning set
npm run eval -- holdout.json          # rules, held-out set
npm run eval -- holdout.json --ai     # rules + AI (needs AI_API_KEY)
```

## Contributing a pattern

Found a new version of this scam? Open an issue with a link to a public post or news story (not a screenshot of someone's private messages) and a one-line paraphrase of the message. We'll add a paraphrased case to `testset.json`, or to a new held-out set if we change the rules for it.
