import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_DENYLIST, BRAND_LISTS, containsDenylistedBrand, findDenylistedBrands, foldBrandToken, replaceDenylistedBrands,
} from "@/core/relay/brand-denylist";
import { miniBlueprint } from "./fixtures/mini-blueprint";

const brands = (text: string, site: "name" | "prose" = "prose") => findDenylistedBrands(text, site).map((h) => h.brand);

describe("brand denylist (lint B1 data, PLATFORM §3.4)", () => {
  it("covers the gallery list, the top-50 banks and insurers and a Fortune-500 list", () => {
    const count = (list: string) => BRAND_DENYLIST.filter((e) => e.list === list).length;
    expect(new Set(BRAND_DENYLIST.map((e) => e.list))).toEqual(new Set(BRAND_LISTS));
    expect(count("bank")).toBeGreaterThanOrEqual(50);
    expect(count("insurer")).toBeGreaterThanOrEqual(50);
    expect(count("gallery")).toBeGreaterThanOrEqual(80);
    expect(count("fortune500")).toBeGreaterThanOrEqual(300);
    expect(BRAND_DENYLIST.length).toBeGreaterThanOrEqual(650);
  });

  it("entries are unique by folded tokens, non-empty, and each one matches its own name", () => {
    const keys = BRAND_DENYLIST.map((e) => e.tokens.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of BRAND_DENYLIST) {
      expect(e.tokens.length).toBeGreaterThan(0);
      expect(containsDenylistedBrand(e.name, "name"), e.name).toBe(true);
      const prose = e.tier === "name" ? `calling from ${e.name} today` : `we are ${e.name} today`;
      expect(containsDenylistedBrand(prose), `${e.name} (${e.tier})`).toBe(true);
    }
  });

  it("matches on word boundaries, folding case, accents, punctuation and 'and'/'&'", () => {
    expect(brands("I'm Wells Fargo's AI assistant")).toEqual(["Wells Fargo"]);
    expect(brands("WELLS FARGO")).toEqual(["Wells Fargo"]);
    expect(brands("wells-fargo")).toEqual(["Wells Fargo"]);
    expect(brands("Verizonia and Geicoland")).toEqual([]);
    expect(brands("Nestlé Verizón")).toEqual(["Verizon"]);
    expect(brands("AT&T and T-Mobile")).toEqual(["AT&T", "T-Mobile"]);
    expect(brands("Johnson and Johnson")).toEqual(["Johnson & Johnson"]);
    expect(brands("look at and to the")).toEqual([]);
    expect(brands("McDonald's")).toEqual(["McDonald's"]);
    expect(foldBrandToken("And")).toBe("&");
  });

  it("prefers the longest entry and reports exact offsets", () => {
    const text = "Pay with JPMorgan Chase today";
    const [h] = findDenylistedBrands(text);
    expect(h).toMatchObject({ brand: "JPMorgan Chase", list: "bank" });
    expect(text.slice(h!.start, h!.end)).toBe("JPMorgan Chase");
  });

  it("capitalized tier: ordinary lower-case words pass", () => {
    expect(brands("Your target date is set")).toEqual([]);
    expect(brands("Shop at Target")).toEqual(["Target"]);
    expect(brands("the best buy in town")).toEqual([]);
    expect(brands("I'm Chase's assistant")).toEqual(["Chase"]);
    expect(brands("Take two minutes")).toEqual([]);
    expect(brands("Bank of America")).toEqual(["Bank of America"]);
    expect(brands("Booking.com")).toEqual(["Booking.com"]);
  });

  it("acronyms outside the exact tier match only in capitals", () => {
    expect(brands("Thanks for the sign-ups and Follow-Ups")).toEqual([]);
    expect(brands("Ship it with UPS")).toEqual(["UPS"]);
    expect(brands("Ups & Downs Bakery", "name")).toEqual([]);
    expect(brands("geico dental", "name")).toEqual(["GEICO"]);   // exact tier: any case
  });

  it("name tier: always in a business name, in prose only as a possessive or after a cue word", () => {
    expect(brands("Nationwide 5G coverage is included")).toEqual([]);
    expect(brands("the frontier of dental care")).toEqual([]);
    expect(brands("Nationwide's AI assistant")).toEqual(["Nationwide"]);
    expect(brands("I'm calling from Frontier about your plan")).toEqual(["Frontier"]);
    expect(brands("Nationwide Plumbing", "name")).toEqual(["Nationwide"]);
    expect(brands("Nationwide Insurance")).toEqual(["Nationwide Insurance"]);
  });

  it("common surnames and place names are listed only in multi-word forms", () => {
    for (const org of ["Root & Crown Dental", "Lincoln Family Dental", "Erie Smiles", "Abbott Street Clinic", "Campbell Dental",
      "Hartford Hills Dental", "Pinnacle Dental", "Cox Family Orthodontics"]) {
      expect(brands(org, "name"), org).toEqual([]);
    }
    expect(brands("Dr. Campbell's office")).toEqual([]);
  });

  it("the fictional names this repo uses stay legal", () => {
    const baton = JSON.parse(readFileSync("data/relays/baton-add-driver.json", "utf8")) as { context: { samples: { org: { name: string } }[] } };
    const names = [...baton.context.samples.map((s) => s.org.name), miniBlueprint().context.samples[0]!.org.name,
      "BrightSmile Plus", "Brightwater Dental", "Harborview Insurance Agency"];
    for (const n of names) expect(brands(n, "name"), n).toEqual([]);
  });

  it("replaceDenylistedBrands swaps each hit for a fictional name", () => {
    expect(replaceDenylistedBrands("Welcome to Aspen Dental, part of Delta Dental's network.", "Brightwater Dental"))
      .toBe("Welcome to Brightwater Dental, part of Brightwater Dental's network.");
    expect(replaceDenylistedBrands("Call Verizon", (h) => `<${h.list}>`)).toBe("Call <gallery>");
    expect(replaceDenylistedBrands("nothing here", "X")).toBe("nothing here");
  });
});
