export type PaymentStatus = "new" | "held" | "refunded" | "kept" | "reported";

export type Payment = {
  id: string; // PayPal capture / transaction id
  payerEmail: string | null;
  payerName: string | null;
  amountCents: number;
  currency: string;
  feeCents: number | null;
  note: string | null; // note the sender attached to the payment (untrusted)
  message: string | null; // follow-up message the seller pasted in (untrusted)
  receivedAt: string;
  source: "webhook" | "search" | "lookup" | "demo";
  status: PaymentStatus;
  refundedCents: number;
};

export type Order = {
  id: string;
  buyerEmail: string | null;
  buyerName: string | null;
  totalCents: number;
  currency: string;
  description: string;
  status: "open" | "paid";
  createdAt: string;
};

export type KnownPayer = {
  email: string;
  name: string;
  kind: "customer" | "payout";
  note: string;
};

export type Risk = "high" | "medium" | "low";

export type Category =
  | "clawback_scam" // stranger pays, then asks for it back some other way
  | "overpayment" // matches an order but pays too much
  | "possible_mistake" // stranger pays, no request yet
  | "payout" // a known payout sender (settlement, marketplace)
  | "expected"; // matches an open order

export type Signal = { code: string; weight: "strong" | "weak" | "reassuring"; text: string };

export type Assessment = {
  risk: Risk;
  category: Category;
  signals: Signal[];
  matchedOrderId: string | null;
  suggestedRefundCents: number; // 0 means "don't suggest a refund"
};

export type Explanation = {
  summary: string;
  whatToDo: string;
  replyDraft: string;
  messageFlags: string[]; // tactics the AI saw in the untrusted text
  model: string; // "rules" when no AI was used
};
