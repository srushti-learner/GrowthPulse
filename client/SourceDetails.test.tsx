// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceExcerpt, ProductVariants, SourceReference } from "./SourceDetails";
import { SupportingEvidence } from "./BusinessBriefing";

describe("customer-facing source details", () => {
  function render(content: React.ReactNode) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(content);
    return container;
  }
  it("formats saved product excerpts, nested offers and variants without raw JSON or unknown keys", () => {
    const quote = JSON.stringify({
      description: "Cotton tee.\nWash with care.", variants: '{"color":"Blue","size":"M"}',
      offers: '[{"price":"0","currency":"INR","availability":"https://schema.org/InStock"}]',
      internalRecordId: "private-reference",
    });
    const container = render(<EvidenceExcerpt quote={quote} />);
    expect(container.textContent).toContain("Cotton tee.\nWash with care.");
    expect(container.textContent).toContain("ColourBlue");
    expect(container.textContent).toContain("Price0");
    expect(container.textContent).toContain("CurrencyINR");
    expect(container.textContent).toContain("AvailabilityIn stock");
    for (const technical of ["private-reference", "internalRecordId", '{"', "\\n", "schema.org", "in_stock"]) {
      expect(container.textContent).not.toContain(technical);
    }
    expect(render(<ProductVariants value='{"size":"M","color":"Blue"}' />).textContent).toContain("SizeMColourBlue");
  });
  it("keeps ordinary quotes intact, translates field paths and explains incomplete excerpts", () => {
    const ordinary = "Everyday clothing: made for you.\nCheck the sizing guide.";
    expect(render(<EvidenceExcerpt quote={ordinary} />).textContent).toBe(ordinary);
    const fields = render(<EvidenceExcerpt quote={"Previously captured, not current.\nname: Cotton tee\noffers[0].priceCurrency: INR\noffers[0].price: 499\noffers[0].availability: https://schema.org/InStock"} />);
    expect(fields.textContent).toContain("Previously captured, not current.");
    expect(fields.textContent).toContain("Offers 1 / CurrencyINR");
    expect(fields.textContent).toContain("Offers 1 / AvailabilityIn stock");
    expect(fields.textContent).not.toContain("offers[0].priceCurrency");
    expect(fields.textContent).not.toContain("schema.org");
    const broken = render(<EvidenceExcerpt quote='{"description":"Incomplete' />);
    expect(broken.textContent).toContain("could not be displayed");
    expect(broken.textContent).not.toContain('{"description"');
    expect(render(<EvidenceExcerpt quote={JSON.stringify({ offers: '[{"price":"499"' })} />).textContent).toContain("excerpt is incomplete");
  });
  it("hides internal references and retains useful CSV rows and safe website links", () => {
    expect(render(<SourceReference source="manual" reference="products/internal-id" />).textContent).toBe("Saved catalogue");
    expect(render(<SourceReference source="csv" reference="CSV row 2" />).textContent).toBe("CSV row 2");
    const page = render(<SourceReference source="website" reference="https://shop.example.com/products/tee" />);
    expect(page.querySelector("a")?.href).toBe("https://shop.example.com/products/tee");
    expect(page.textContent).toBe("View source page · shop.example.com");
    for (const reference of ["javascript:alert(1)", "https://user:password@shop.example.com/"]) {
      const invalid = render(<SourceReference source="website" reference={reference} />);
      expect(invalid.querySelector("a")).toBeNull();
      expect(invalid.textContent).toBe("Source page unavailable");
    }
  });
  it("applies the same presentation to shared Overview, Market and Growth evidence without empty disclosures", () => {
    const quote = '{"description":"Cotton tee."}';
    const container = render(<SupportingEvidence sources={[{ url: "https://shop.example.com/", quote }]} />);
    expect(container.querySelector("dt")?.textContent).toBe("Description");
    expect(container.querySelector("dd")?.textContent).toBe("Cotton tee.");
    expect(container.textContent).not.toContain(quote);
    expect(container.querySelector("a")?.href).toBe("https://shop.example.com/");
    expect(render(<SupportingEvidence sources={[]} />).querySelector("details")).toBeNull();
  });
});
