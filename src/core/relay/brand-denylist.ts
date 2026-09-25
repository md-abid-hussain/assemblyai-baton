/**
 * relay/brand-denylist.ts - the brand denylist behind lint B1 (PLATFORM §3.4, P14). WP14a. Pure and isomorphic.
 *
 * A relay is spoken by our Voice Agent on our domain; it must never pose as a real company. B1 fails any relay whose
 * business name or spoken/shown text names a denylisted brand: the gallery list (the real brands of the gallery's
 * domains: dental, telecom, auto insurance, payments and e-sign) plus a Fortune-500 list and the top-50 US banks and
 * insurers. The drafting pipeline (PLATFORM §7.4 step 5) uses `replaceDenylistedBrands` to swap them for a fictional
 * name.
 *
 * Matching is word-boundary on tokens (runs of letters/digits, and "&"; "and" counts as "&"), accent- and
 * case-folded, so "Wells Fargo's", "WELLS FARGO" and "Wells-Fargo" all hit "Wells Fargo", but "Brightwater" does not
 * hit "Bright Now". No RegExp is built from a string (TASKS-v2 §2 rule 10): entries are token lists.
 *
 * Three tiers keep ordinary English out of it:
 *   - `exact`: distinctive names ("Verizon", "GEICO"), matched in any case;
 *   - `capitalized`: names that are also a lower-case word or phrase ("Target", "Best Buy", "Workday"), matched in
 *     prose only when every word is capitalized (inner "of", "the", "'s", ".com" excepted: "Bank of America");
 *   - `name`: capitalized words common in prose ("Nationwide", "Discover", "Frontier"). They always fail a business
 *     name (`site: "name"`, e.g. a sample's `org.name`); in prose only in the impersonation shapes: the possessive
 *     ("Nationwide's assistant") or after "from", "at", "with", "for", "by", "is", "call(ing)", "contact", "visit",
 *     "join", "chose" ("calling from Frontier").
 * Outside `exact`, an acronym entry ("UPS", "HP", "AAA") matches only in capitals, so "sign-ups" is not "UPS".
 * Multi-word forms of the `name` tier ("Nationwide Insurance", "Frontier Communications") are `exact`/`capitalized`.
 * Words that are also common surnames, first names or place names in business names ("Lincoln", "Erie", "Root",
 * "Abbott") are listed only in their multi-word forms, so "Root & Crown Dental" stays legal.
 */

export const BRAND_LISTS = ["gallery", "bank", "insurer", "fortune500"] as const;
export type BrandList = (typeof BRAND_LISTS)[number];
export const BRAND_LIST_LABEL: Readonly<Record<BrandList, string>> = {
  gallery: "gallery-domain brand",
  bank: "top-50 US bank",
  insurer: "top-50 US insurer",
  fortune500: "Fortune 500 company",
};

export type BrandTier = "exact" | "capitalized" | "name";
/** `name`: the whole text is a business name (every tier matches in any case; acronyms in capitals). `prose`: sentences (tier rules apply). */
export type BrandSite = "name" | "prose";

interface ListSpec { exact: readonly string[]; capitalized: readonly string[]; name: readonly string[] }

// ============================================================================================ the lists

const GALLERY: ListSpec = {
  exact: [
    // dental chains, DSOs, plans and suppliers
    "Aspen Dental", "Heartland Dental", "Delta Dental", "ClearChoice", "SmileDirectClub", "Invisalign", "Align Technology",
    "United Concordia", "Ameritas", "DentaQuest", "Dentsply Sirona", "Henry Schein", "Colgate", "Colgate-Palmolive",
    "Oral-B", "Sonicare", "Philips Sonicare", "Liberty Dental Plan", "Guardian Dental", "Cigna Dental", "MetLife Dental",
    "Humana Dental",
    // telecom carriers and ISPs
    "Verizon", "Verizon Wireless", "Verizon Fios", "Fios", "AT&T", "T-Mobile", "MetroPCS", "Comcast", "Xfinity",
    "Charter Communications", "Charter Spectrum", "Spectrum Mobile", "Spectrum Internet", "Cox Communications",
    "Cox Mobile", "Altice", "Altice USA", "Frontier Communications", "Lumen Technologies", "CenturyLink", "Windstream",
    "UScellular", "Boost Mobile", "Cricket Wireless", "Mint Mobile", "Visible Wireless", "TracFone", "DirecTV",
    "Dish Network", "EchoStar", "Mediacom", "Suddenlink", "Ziply Fiber", "Starlink", "Viasat", "HughesNet", "Vonage",
    "RingCentral", "Twilio", "Ting Mobile", "Google Fi", "Google Fiber",
    // payments, wallets, e-sign
    "PayPal", "Venmo", "Zelle", "Apple Pay", "Google Pay", "Samsung Pay", "Klarna", "Afterpay", "Mastercard",
    "American Express", "Amex", "DocuSign", "Adobe Sign", "Dropbox Sign", "HelloSign", "PandaDoc", "MoneyGram",
    "Coinbase", "Robinhood", "SoFi", "TurboTax", "QuickBooks", "Equifax", "TransUnion", "Experian",
  ],
  capitalized: [
    "Pacific Dental", "Pacific Dental Services", "Western Dental", "Smile Brands", "Great Expressions",
    "Great Expressions Dental", "Coast Dental", "Castle Dental", "Bright Now Dental", "Monarch Dental", "Comfort Dental",
    "Gentle Dental", "Midwest Dental", "Dental Care Alliance", "Mortenson Dental", "Patterson Dental", "Crest",
    "Sprint", "US Cellular", "U.S. Cellular", "Straight Talk", "Total Wireless", "Consumer Cellular", "Stripe",
    "Cash App", "Western Union", "Credit Karma", "Visa",
  ],
  name: ["Spectrum", "Optimum", "Frontier", "Chime"],
};

const BANKS: ListSpec = {
  exact: [
    "JPMorgan", "JPMorgan Chase", "J.P. Morgan", "Chase Bank", "BofA", "Citigroup", "Citibank", "Wells Fargo",
    "Goldman Sachs", "Morgan Stanley", "PNC", "PNC Bank", "Truist", "TD Bank", "Charles Schwab", "BNY Mellon",
    "Bank of New York Mellon", "HSBC", "BMO", "BMO Harris", "KeyBank", "KeyCorp", "M&T Bank", "Synchrony",
    "Santander", "Comerica", "Wintrust", "Synovus", "UMB Bank", "Hancock Whitney", "BankUnited", "Umpqua",
    "SouthState", "Flagstar", "PenFed", "Barclays", "Deutsche Bank", "UBS", "Credit Suisse", "Silicon Valley Bank",
    "Raymond James", "Stifel", "BlackRock", "Ameriprise", "LPL Financial", "Navient", "Sallie Mae", "OneMain",
  ],
  capitalized: [
    "Chase", "Bank of America", "Citi", "US Bank", "U.S. Bank", "U.S. Bancorp", "US Bancorp", "Capital One", "Schwab",
    "State Street", "Northern Trust", "Fifth Third", "Fifth Third Bank", "Huntington Bank", "Huntington National Bank",
    "Ally Bank", "Ally Financial", "Discover Bank", "Discover Card", "Discover Financial", "Citizens Bank",
    "Citizens Financial", "First Citizens", "Regions Bank", "Regions Financial", "Zions Bank", "Zions Bancorporation",
    "Webster Bank", "First Horizon", "Western Alliance", "Popular Bank", "Banco Popular", "East West Bank", "Frost Bank",
    "Valley National Bank", "Bank of Oklahoma", "BOK Financial", "Associated Bank", "Old National Bank", "Pinnacle Bank",
    "Pinnacle Financial", "Cadence Bank", "Prosperity Bank", "Columbia Bank", "Commerce Bank", "Fulton Bank",
    "Texas Capital Bank", "Navy Federal", "Navy Federal Credit Union", "First Republic", "Signature Bank",
    "Fidelity Investments", "Fidelity", "Vanguard", "Edward Jones", "E*Trade",
  ],
  name: ["Ally", "Citizens", "Regions", "Discover"],
};

const INSURERS: ListSpec = {
  exact: [
    "GEICO", "Allstate", "USAA", "Liberty Mutual", "Farmers Insurance", "Nationwide Insurance", "Nationwide Mutual",
    "Travelers Insurance", "Travelers Companies", "AmFam", "Auto-Owners", "Auto Owners Insurance", "Kemper", "CSAA",
    "Chubb", "AIG", "Safeco", "MetLife", "MassMutual", "Aflac", "Unum", "Transamerica", "Voya", "Primerica", "Allianz",
    "AXA", "Esurance", "Clearcover", "Metromile", "Hagerty", "Assurant", "Markel", "Genworth", "Corebridge",
    "UnitedHealthcare", "UnitedHealth", "Optum", "Elevance", "Cigna", "Aetna", "Centene", "Ambetter", "Molina Healthcare",
    "Kaiser Permanente", "BlueCross BlueShield", "Highmark", "Wellcare", "Humana", "Anthem Blue Cross",
  ],
  capitalized: [
    "State Farm", "Progressive", "Progressive Insurance", "American Family Insurance", "Erie Insurance",
    "Mercury Insurance", "The Hartford", "Hartford Financial", "American International Group", "Zurich Insurance",
    "Cincinnati Insurance", "Cincinnati Financial", "Hanover Insurance", "Selective Insurance", "Sentry Insurance",
    "Amica", "Country Financial", "Shelter Insurance", "Grange Insurance", "Westfield Insurance", "Prudential",
    "New York Life", "Northwestern Mutual", "Mass Mutual", "Lincoln Financial", "Lincoln National", "Principal Financial",
    "Guardian Life", "Pacific Life", "Brighthouse Financial", "Protective Life", "Mutual of Omaha", "Globe Life",
    "Jackson National", "Root Insurance", "Lemonade", "Hippo Insurance", "Plymouth Rock", "Bristol West",
    "Dairyland Insurance", "National General", "Encompass Insurance", "Infinity Insurance", "W. R. Berkley", "WR Berkley",
    "Old Republic", "Fidelity National Financial", "First American Financial", "CNA Financial", "Loews",
    "Oscar Health", "Blue Cross", "Blue Shield", "Florida Blue", "Anthem", "AAA Insurance", "Farmers Insurance Group",
  ],
  name: ["Nationwide", "Travelers", "AAA"],
};

const FORTUNE_500: ListSpec = {
  exact: [
    // retail, consumer, restaurants
    "Walmart", "Wal-Mart", "Sam's Club", "Costco", "Kroger", "Albertsons", "Safeway", "Publix", "Walgreens",
    "Walgreens Boots Alliance", "CVS", "CVS Health", "Rite Aid", "Lowe's", "Lowes", "Macy's", "Kohl's", "Nordstrom",
    "TJX", "TJ Maxx", "T.J. Maxx", "HomeGoods", "AutoZone", "O'Reilly Auto Parts", "O'Reilly Automotive", "CarMax",
    "Carvana", "AutoNation", "Wayfair", "eBay", "Etsy", "Ulta Beauty", "Starbucks", "McDonald's", "McDonalds",
    "Chipotle Mexican Grill", "Darden", "Yum! Brands", "KFC", "Taco Bell", "Pizza Hut", "Sysco",
    "PepsiCo", "Pepsi", "Coca-Cola", "Keurig Dr Pepper", "Molson Coors", "Anheuser-Busch", "Altria",
    "Philip Morris", "Procter & Gamble", "P&G", "Johnson & Johnson", "Kimberly-Clark", "Clorox", "Estee Lauder",
    "Kraft Heinz", "General Mills", "Kellogg's", "Kellogg Company", "Kellanova", "Mondelez", "Conagra", "Hormel",
    "Tyson Foods", "Smucker", "McCormick & Company", "Nike", "Skechers", "Levi Strauss", "Ralph Lauren", "Hanesbrands", "Mattel", "Hasbro",
    "Newell Brands", "Williams-Sonoma", "Bath & Body Works", "Victoria's Secret", "GameStop",
    "Dick's Sporting Goods", "BJ's Wholesale", "Office Depot", "OfficeMax",
    // tech, media, telecom
    "Amazon.com", "Alphabet Inc", "YouTube", "Microsoft", "Facebook", "Instagram", "WhatsApp",
    "Meta Platforms", "Nvidia", "Qualcomm", "Broadcom", "Cisco", "IBM", "Hewlett Packard", "Hewlett Packard Enterprise",
    "HPE", "ServiceNow", "Netflix", "Lyft", "Airbnb", "DoorDash", "Expedia", "Booking Holdings",
    "Texas Instruments", "Micron Technology", "Lam Research", "Advanced Micro Devices", "AMD",
    "Western Digital", "NetApp", "Jabil", "Sanmina", "TD Synnex", "CDW", "Amphenol", "Motorola", "Motorola Solutions",
    "Kyndryl", "Leidos", "Booz Allen", "Booz Allen Hamilton", "CACI", "Palo Alto Networks", "Akamai",
    "Walt Disney", "Disney", "Warner Bros", "Warner Bros. Discovery", "Paramount Global", "NBCUniversal",
    "Fox Corporation", "iHeartMedia",
    // finance and payments
    "Berkshire Hathaway", "Fannie Mae", "Freddie Mac", "Fiserv", "Mastercard", "Visa Inc", "CME Group", "Nasdaq",
    "S&P Global", "TIAA", "Blackstone", "KKR",
    // health
    "UnitedHealth Group", "McKesson", "Cencora", "AmerisourceBergen", "Cardinal Health", "HCA Healthcare",
    "Tenet Healthcare", "DaVita", "LabCorp", "Quest Diagnostics", "Pfizer", "Merck", "AbbVie", "Bristol-Myers Squibb",
    "Eli Lilly", "Amgen", "Gilead", "Regeneron", "Biogen", "Moderna", "Viatris", "Zoetis", "Thermo Fisher",
    "Abbott Laboratories", "Stryker", "Boston Scientific", "Becton Dickinson", "Baxter International", "Zimmer Biomet",
    "Danaher", "IQVIA", "Owens & Minor", "Humana Inc",
    // energy, industry, transport
    "Exxon", "ExxonMobil", "Exxon Mobil", "Mobil", "ConocoPhillips", "Phillips 66", "Valero", "Marathon Petroleum",
    "Occidental Petroleum", "Halliburton", "Baker Hughes", "Schlumberger", "Kinder Morgan", "Cheniere", "NextEra",
    "NextEra Energy", "Duke Energy", "Dominion Energy", "Exelon", "American Electric Power", "Xcel Energy", "PG&E",
    "Pacific Gas and Electric", "Edison International", "Southern California Edison", "Sempra", "Con Edison",
    "ConEd", "Entergy", "FirstEnergy", "DTE Energy", "PSEG", "Ameren", "Constellation Energy", "Vistra",
    "NRG Energy", "Boeing", "Lockheed Martin", "Raytheon", "RTX", "Northrop Grumman", "L3Harris", "Textron",
    "Huntington Ingalls", "Honeywell", "John Deere", "Paccar", "Illinois Tool Works",
    "Stanley Black & Decker", "Sherwin-Williams", "PPG Industries", "DuPont", "Corteva", "Nucor", "Cleveland-Cliffs",
    "Alcoa", "Freeport-McMoRan", "Newmont", "WestRock", "Goodyear", "BorgWarner",
    "Harley-Davidson", "Tesla", "General Motors", "Chevrolet", "Buick", "GMC", "Ford Motor",
    "Ford Motor Company", "United Parcel Service", "FedEx", "Union Pacific", "CSX", "Norfolk Southern",
    "J.B. Hunt", "XPO", "C.H. Robinson", "Delta Air Lines", "United Airlines", "American Airlines", "Southwest Airlines",
    "Alaska Airlines", "JetBlue", "Avis Budget", "Marriott", "Hilton", "Hyatt", "MGM Resorts",
    "Caesars Entertainment", "Las Vegas Sands", "Royal Caribbean", "Carnival Corporation", "Carnival Cruise",
    "Norwegian Cruise Line", "Equinix", "Prologis", "Simon Property", "CBRE", "Archer Daniels Midland",
    "Enterprise Products",
    "Lennar", "D.R. Horton", "PulteGroup", "NVR", "Oracle Corporation", "Dow Chemical", "Dow Inc",
  ],
  capitalized: [
    "Amazon", "Apple", "Meta", "Oracle", "Target", "Home Depot", "The Home Depot", "Best Buy", "Dollar General",
    "Dollar Tree", "Family Dollar", "Marshalls", "Ross Stores", "Burlington Stores", "Burlington Coat Factory", "Gap Inc",
    "Old Navy", "Banana Republic", "Chipotle", "Coke", "Campbell Soup", "Hershey", "Domino's", "US Foods", "Chewy",
    "Whirlpool", "Foot Locker", "Tractor Supply", "Five Below", "Big Lots", "Google", "Salesforce", "Workday",
    "Applied Materials", "Cognizant", "Electronic Arts", "Take-Two", "Global Payments", "Intercontinental Exchange",
    "Moody's", "CenterPoint", "3M", "UPS", "International Paper", "Cadillac", "Hertz", "Avis", "Waste Management",
    "Republic Services", "American Tower", "Crown Castle", "Energy Transfer", "Intel", "HP", "HP Inc", "Dell",
    "Dell Technologies", "Micron", "Adobe", "Intuit", "Uber", "Ford", "Chevron", "Caterpillar", "General Electric",
    "GE Aerospace", "GE HealthCare", "General Dynamics", "Dow", "Deere", "Cummins Inc", "Humana Health", "Merck & Co",
    "Southern Company", "Booking.com", "Paramount", "Paramount Pictures", "Fox News", "Warner Bros Discovery",
    "Enterprise Rent-A-Car",
  ],
  name: [],
};

// ============================================================================================ index

export interface BrandEntry {
  name: string;
  list: BrandList;
  tier: BrandTier;
  /** Folded tokens ("and" is "&"). */
  tokens: readonly string[];
  /** Per token: an acronym ("UPS", "HP", "AAA": all capitals, 2+ letters) must be written in capitals outside the `exact` tier. */
  acronym: readonly boolean[];
}

const TOKEN_RE = /[\p{L}\p{N}]+|&/gu;
const MARKS_RE = /\p{M}+/gu;

/** Accent- and case-folded token; "and" is "&". */
export const foldBrandToken = (t: string): string => {
  const f = t.normalize("NFKD").replace(MARKS_RE, "").toLowerCase();
  return f === "and" ? "&" : f;
};

interface Token { raw: string; key: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ raw: m[0], key: foldBrandToken(m[0]), start, end: start + m[0].length });
  }
  return out;
}

const letters = (raw: string): string => [...raw].filter((ch) => ch.toLowerCase() !== ch.toUpperCase()).join("");
const isAllCaps = (raw: string): boolean => { const l = letters(raw); return l.length > 0 && l === l.toUpperCase(); };
const isAcronym = (raw: string): boolean => letters(raw).length >= 2 && isAllCaps(raw);

/** exact matches the most text, name the least. A name listed twice keeps its first list and the tier that matches more. */
const TIER_RANK: Readonly<Record<BrandTier, number>> = { exact: 0, capitalized: 1, name: 2 };

function buildDenylist(): BrandEntry[] {
  const byKey = new Map<string, BrandEntry>();
  const lists: [BrandList, ListSpec][] = [["gallery", GALLERY], ["bank", BANKS], ["insurer", INSURERS], ["fortune500", FORTUNE_500]];
  for (const [list, spec] of lists) {
    for (const tier of ["exact", "capitalized", "name"] as const) {
      for (const name of spec[tier]) {
        const toks = tokenize(name);
        if (toks.length === 0) continue;
        const tokens = toks.map((t) => t.key);
        const key = tokens.join(" ");
        const prev = byKey.get(key);
        if (!prev) byKey.set(key, { name, list, tier, tokens, acronym: toks.map((t) => isAcronym(t.raw)) });
        else if (TIER_RANK[tier] < TIER_RANK[prev.tier]) byKey.set(key, { ...prev, tier });
      }
    }
  }
  return [...byKey.values()];
}

/** Every denylisted brand, deduplicated by its folded token list. */
export const BRAND_DENYLIST: readonly BrandEntry[] = buildDenylist();

const BY_FIRST: ReadonlyMap<string, readonly BrandEntry[]> = (() => {
  const m = new Map<string, BrandEntry[]>();
  for (const e of BRAND_DENYLIST) {
    const k = e.tokens[0]!;
    const arr = m.get(k) ?? [];
    arr.push(e);
    m.set(k, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => b.tokens.length - a.tokens.length);   // longest first
  return m;
})();

// ============================================================================================ matching

/** A word counts as capitalized when its first letter is upper case (digits and "&" pass). */
function capitalized(raw: string): boolean {
  const l = letters(raw);
  return l.length === 0 || l[0] === l[0]!.toUpperCase();
}

/** Words inside a name that stay lower case ("Bank of America", "McDonald's", "Booking.com"); never the first word. */
const SMALL_WORDS: ReadonlySet<string> = new Set(["of", "the", "by", "for", "a", "s", "com", "&"]);

/** Words before a `name`-tier brand that make prose read as a business name ("calling from Frontier"). */
const NAME_CUES: ReadonlySet<string> = new Set(["from", "at", "with", "for", "by", "is", "call", "calling", "called", "contact", "visit", "join", "joined", "choose", "chose", "chosen"]);
const POSSESSIVE_RE = /^['\u2019]s(?![\p{L}\p{N}])/u;

export interface BrandHit {
  /** The denylist entry's canonical name. */
  brand: string;
  list: BrandList;
  tier: BrandTier;
  /** Offsets into the input text: `text.slice(start, end)` is the matched span. */
  start: number;
  end: number;
  text: string;
}

function entryMatches(e: BrandEntry, toks: readonly Token[], i: number, text: string, site: BrandSite): boolean {
  const n = e.tokens.length;
  if (i + n > toks.length) return false;
  for (let k = 0; k < n; k++) if (toks[i + k]!.key !== e.tokens[k]) return false;
  if (e.tier === "exact") return true;
  for (let k = 0; k < n; k++) {
    const t = toks[i + k]!;
    if (e.acronym[k] && !isAllCaps(t.raw)) return false;
    if (site === "prose" && !(k > 0 && SMALL_WORDS.has(t.key)) && !capitalized(t.raw)) return false;
  }
  if (site === "name" || e.tier === "capitalized") return true;
  const end = toks[i + n - 1]!.end;
  if (POSSESSIVE_RE.test(text.slice(end, end + 3))) return true;
  const prev = i > 0 ? toks[i - 1]!.key : null;
  return prev !== null && NAME_CUES.has(prev);
}

/**
 * Every denylisted brand in `text`, left to right, longest match first, non-overlapping. `site: "name"` for a text
 * that is a business name (every tier matches in any case, acronyms in capitals); `"prose"` (the default) applies the
 * tier rules.
 */
export function findDenylistedBrands(text: string, site: BrandSite = "prose"): BrandHit[] {
  const toks = tokenize(text);
  const hits: BrandHit[] = [];
  for (let i = 0; i < toks.length;) {
    const cands = BY_FIRST.get(toks[i]!.key);
    const e = cands?.find((c) => entryMatches(c, toks, i, text, site));
    if (!e) { i++; continue; }
    const start = toks[i]!.start;
    const end = toks[i + e.tokens.length - 1]!.end;
    hits.push({ brand: e.name, list: e.list, tier: e.tier, start, end, text: text.slice(start, end) });
    i += e.tokens.length;
  }
  return hits;
}

/** True when `text` contains a denylisted brand. */
export const containsDenylistedBrand = (text: string, site: BrandSite = "prose"): boolean => findDenylistedBrands(text, site).length > 0;

/**
 * Replaces every denylisted brand in `text` (the drafting post-fix, PLATFORM §7.4 step 5). `replacement` is a
 * fictional name, or a function of the hit.
 */
export function replaceDenylistedBrands(text: string, replacement: string | ((hit: BrandHit) => string), site: BrandSite = "prose"): string {
  const hits = findDenylistedBrands(text, site);
  if (hits.length === 0) return text;
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + (typeof replacement === "string" ? replacement : replacement(h));
    at = h.end;
  }
  return out + text.slice(at);
}
