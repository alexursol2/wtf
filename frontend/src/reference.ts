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
 * Only ACME30 is actually deployed — it is the T-REX/ERC-3643 security token
 * this venue was built around. The other two are listed because a venue with
 * one instrument does not look like a venue, but they are marked `live: false`
 * and the UI must say so rather than pretending there is a book behind them.
 * Inventing liquidity would be the same class of lie as inventing a decrypted
 * number.
 */
export interface Instrument {
  /** Symbol as shown on the tape and in the selector. */
  symbol: string;
  /** Quote currency — every pair here settles against cash escrow. */
  quote: string;
  name: string;
  /** Whether this instrument has a deployed token and a real book. */
  live: boolean;
}

export const INSTRUMENTS: Instrument[] = [
  { symbol: "ACME30", quote: "USD", name: "ACME 2030 senior note", live: true },
  { symbol: "AAPL.rwa", quote: "USD", name: "Apple Inc. tokenised equity", live: false },
  { symbol: "TSLA.rwa", quote: "USD", name: "Tesla Inc. tokenised equity", live: false },
];

export const pairLabel = (i: Instrument) => `${i.symbol} / ${i.quote}`;
