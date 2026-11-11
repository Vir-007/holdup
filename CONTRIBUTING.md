# Contributing

Thanks for helping. The most useful contributions:

- **New scam patterns.** Open an issue with a link to a public post or news story and a one-line paraphrase of the message. Please don't paste other people's private messages. See [patterns/README.md](patterns/README.md).
- **Rule fixes.** If Hold Up misses a scam or raises a false alarm, add the case to `patterns/testset.json` (or a test in `test/rules.test.ts`), then change `src/rules.ts`. Run `npm test && npm run eval` before opening a pull request.
- **Translations of the seller-facing text** in `public/app.js` and `src/ai.ts`.

## Setup

```bash
npm install
DEMO=1 npm run dev     # restarts on change, sample data, no keys needed
npm test
npm run typecheck
```

## Ground rules

- The only PayPal call that moves money is `refundCapture` in `src/paypal.ts`. Pull requests that add another way to send money won't be merged: a new payment is exactly what the scam asks for.
- The AI explains and may raise risk; it never lowers risk and never calls tools.
- Anything the sender wrote is shown as text, never HTML.
