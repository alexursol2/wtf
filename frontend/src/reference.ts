/**
 * Reference data the UI needs to speak in institutional terms rather than raw
 * protocol values.
 *
 * ERC-3643 stores investor country as an ISO 3166-1 *numeric* code, so the
 * registry hands us `250` and the header used to print "country 250". Nobody
 * reading a compliance badge thinks in numeric ISO codes; they think "France".
 * The code is still the authoritative value, so it moves into the tooltip
 * rather than being dropped.
 */

/** ISO 3166-1 numeric → English short name. */
export const ISO_COUNTRY: Record<number, string> = {
  36: "Australia",
  40: "Austria",
  56: "Belgium",
  76: "Brazil",
  124: "Canada",
  156: "China",
  191: "Croatia",
  196: "Cyprus",
  203: "Czechia",
  208: "Denmark",
  233: "Estonia",
  246: "Finland",
  250: "France",
  276: "Germany",
  300: "Greece",
  344: "Hong Kong",
  348: "Hungary",
  352: "Iceland",
  356: "India",
  372: "Ireland",
  376: "Israel",
  380: "Italy",
  392: "Japan",
  428: "Latvia",
  438: "Liechtenstein",
  440: "Lithuania",
  442: "Luxembourg",
  470: "Malta",
  484: "Mexico",
  528: "Netherlands",
  554: "New Zealand",
  578: "Norway",
  616: "Poland",
  620: "Portugal",
  642: "Romania",
  643: "Russia",
  682: "Saudi Arabia",
  702: "Singapore",
  703: "Slovakia",
  705: "Slovenia",
  710: "South Africa",
  724: "Spain",
  752: "Sweden",
  756: "Switzerland",
  784: "United Arab Emirates",
  792: "Turkey",
  804: "Ukraine",
  826: "United Kingdom",
  840: "United States",
};

export function countryName(code: number): string {
  return ISO_COUNTRY[code] ?? (code ? `ISO ${code}` : "undeclared");
}

/**
 * Tradable instruments.
 *
 * All three are REAL: each has an ERC-3643 token and a ConfidentialWrapper
 * deployed on Sepolia, sharing the one IdentityRegistry — so an address verified
 * for one is verified for all three, and each can be held, hidden and traded.
 *
 * Each has its own BOOK. `Order` and `Fill` carry a plaintext `uint8 instrument`
 * whose value is an index into this array — so the order of these entries is
 * part of the on-chain contract with the seeding scripts, and appending is safe
 * while reordering is not.
 */
export interface Instrument {
  /** Symbol as shown on the tape and in the selector. */
  symbol: string;
  /** Quote currency — every pair here settles against cash escrow. */
  quote: string;
  name: string;
  /** Plaintext ERC-3643 token — the balance you hold before hiding it. */
  token: string;
  /** ERC-7984-style wrapper that takes custody and issues an encrypted balance. */
  wrapper: string;
}

/*
 * There is no `indicative` field any more, and its absence is the point.
 *
 * It used to carry a shipped price per instrument so the screen had a number
 * before anything traded. But a hardcoded level is not a price: it comes from
 * this file rather than from the venue, it never moves when the market does,
 * and every panel that quoted it was quoting the frontend to itself. The only
 * price this venue can honestly state is the price leg of a settled fill, once
 * its maker has reported it — see `lastPrint` and `referencePrice`.
 *
 * The cost is real and accepted: an instrument that has never printed has NO
 * reference, so a market order in it is refused and a percentage allocation
 * cannot convert cash into a size until a limit price is typed. That is the
 * truth about a dark book with no trades in it.
 */

export const INSTRUMENTS: Instrument[] = [
  {
    symbol: "ACME30",
    quote: "USD",
    name: "ACME 2030 senior note",
    token: "0xb0ba5244DF094160Ff31E523Fa5F8a51124f94E7",
    wrapper: "0x28bf0728213275b52c3285a1423bd7e51acb4dd8",
  },
  {
    symbol: "AAPL.rwa",
    quote: "USD",
    name: "Apple Inc. tokenised equity",
    token: "0xDd2B5764dE8C58e2ab1482606bDDE5EdFb9BAf53",
    wrapper: "0xd673ad276a0ea96d346fd6727cee8cd8074826cc",
  },
  {
    symbol: "TSLA.rwa",
    quote: "USD",
    name: "Tesla Inc. tokenised equity",
    token: "0x275E645aF19e67BA5575E76814F4ecC14362d982",
    wrapper: "0x758c57f15cd6090426ed25ebe15a1cc4f2844a9b",
  },
];

export const pairLabel = (i: Instrument) => `${i.symbol} / ${i.quote}`;

/**
 * The cash leg every pair settles against.
 *
 * Here rather than in an env var, alongside the instrument tokens it sits
 * beside. A contract address is not a secret and not a per-environment choice:
 * it is pinned to the same deployment as the wrappers above, so splitting it
 * out only created a variable that could be forgotten — and when it was, the
 * wallet's cash balance silently failed to read and the allocation slider fell
 * back to escrow with no explanation.
 */
export const CASH_TOKEN = "0xb956f6651ec9d7d53c89ae4fb3068988f660b4db";

/*
 * The SEEDED_ORDER_INSTRUMENT / SEEDED_FILL_INSTRUMENT maps that used to live
 * here are gone. They existed only because the venue could not record which
 * instrument an order was for, so the mapping had to be shipped alongside the
 * code and could never cover orders placed from anywhere else. The venue now
 * carries a plaintext instrument field on both Order and Fill, so the chain
 * answers the question directly.
 */
