import type { ReactNode } from "react";

const fieldLabels: Record<string, string> = {
  name: "Product name", description: "Description", sku: "SKU", gtin: "GTIN",
  gtin8: "GTIN", gtin12: "GTIN", gtin13: "GTIN", gtin14: "GTIN",
  price: "Price", currency: "Currency", priceCurrency: "Currency", availability: "Availability",
  variants: "Variants", offers: "Offers", brand: "Brand", category: "Category",
  material: "Material", color: "Colour", size: "Size", pattern: "Pattern",
  image: "Image", imageUrl: "Image", url: "Product page", additionalProperty: "Product detail",
  value: "Value", audience: "Audience", audienceType: "Audience", aggregateRating: "Published rating",
  ratingValue: "Rating", ratingCount: "Rating count", reviewCount: "Review count",
  bestRating: "Highest rating", worstRating: "Lowest rating", lowPrice: "Lowest price",
  highPrice: "Highest price", offerCount: "Offer count", priceValidUntil: "Price valid until",
  itemCondition: "Condition",
};

export function readableAvailability(value: string) {
  const key = value.replace(/^https?:\/\/schema\.org\//, "").replace(/[_\s-]/g, "").toLowerCase();
  const labels: Record<string, string> = {
    instock: "In stock", outofstock: "Out of stock", preorder: "Pre-order",
    backorder: "Back order", soldout: "Sold out", discontinued: "Discontinued",
    limitedavailability: "Limited availability", onlineonly: "Online only", instoreonly: "In-store only",
    unknown: "Not recorded",
  };
  return Object.hasOwn(labels, key) ? labels[key] : value;
}

export function sourcePage(reference: string) {
  try {
    const url = new URL(reference);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

export function SourceReference({ reference, source }: { reference: string; source: "manual" | "csv" | "website" }) {
  const page = source === "website" ? sourcePage(reference) : null;
  if (page) return <a href={page.href} target="_blank" rel="noreferrer">View source page · {page.hostname}</a>;
  return <span>{source === "manual" ? "Saved catalogue" : source === "csv"
    ? /^CSV row \d+$/.test(reference) ? reference : "Imported CSV"
    : "Source page unavailable"}</span>;
}

function fieldValue(key: string, value: unknown, depth: number): ReactNode {
  if (key === "image" || key === "imageUrl") return "Image link recorded";
  if (key === "url") {
    const page = typeof value === "string" ? sourcePage(value) : null;
    return page ? <a href={page.href} target="_blank" rel="noreferrer">View product page</a> : "Product page unavailable";
  }
  if (typeof value === "string" && (key === "offers" || key === "variants" && /^\s*(?:\{|\[\s*[{"])/.test(value))) {
    try { return structuredFields(JSON.parse(value), depth + 1); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return "The saved excerpt is incomplete. Review the source listing for details.";
    }
  }
  if (typeof value === "string") return key === "availability" ? readableAvailability(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return structuredFields(value, depth + 1);
}

function structuredFields(value: unknown, depth = 0): ReactNode {
  if (depth > 3) return "Review the source listing for further details.";
  if (Array.isArray(value)) return value.length
    ? <ul>{value.map((item, index) => <li key={index}>{structuredFields(item, depth + 1)}</li>)}</ul>
    : "No details recorded";
  if (!value || typeof value !== "object") return typeof value === "string" || typeof value === "number"
    ? String(value) : "Source details unavailable";
  const fields = Object.entries(value).filter(([key]) => Object.hasOwn(fieldLabels, key));
  return fields.length ? <dl className="source-fields">{fields.map(([key, entry]) =>
    <div key={key}><dt>{fieldLabels[key]}</dt><dd>{entry && typeof entry === "object"
      ? structuredFields(entry, depth + 1) : fieldValue(key, entry, depth)}</dd></div>)}</dl>
    : "Source details unavailable. Review the original source for context.";
}

export function EvidenceExcerpt({ quote }: { quote: string }) {
  if (/^\s*(?:\{|\[\s*[{"])/.test(quote)) {
    try { return <div className="source-excerpt">{structuredFields(JSON.parse(quote))}</div>; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return <p>The saved excerpt could not be displayed. Review the original source for context.</p>;
    }
  }
  const lines = quote.split("\n");
  if (lines.some((line) => Object.hasOwn(fieldLabels, /^(\w+)(?::|\.|\[)/.exec(line)?.[1] ?? ""))) {
    const fields: { label: string; key: string; value: string }[] = [];
    const preamble: string[] = [];
    for (const line of lines) {
      const match = /^([\w.[\]]+):\s*(.*)$/.exec(line);
      if (match) {
        const parts = match[1].split(".");
        const labels = parts.map((part) => {
          const field = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
          return field && Object.hasOwn(fieldLabels, field[1])
            ? `${fieldLabels[field[1]]}${field[2] === undefined ? "" : ` ${Number(field[2]) + 1}`}` : null;
        });
        if (labels.every((label) => label !== null)) fields.push({ label: labels.join(" / "), key: parts.at(-1)!.replace(/\[\d+\]$/, ""), value: match[2] });
      } else if (fields.length) fields[fields.length - 1].value += `\n${line}`;
      else preamble.push(line);
    }
    return fields.length ? <>{preamble.some((line) => line.trim()) && <p>{preamble.join("\n")}</p>}
      <dl className="source-fields">{fields.map((field, index) =>
        <div key={index}><dt>{field.label}</dt><dd>{fieldValue(field.key, field.value, 0)}</dd></div>)}</dl></>
      : <p>Source details unavailable. Review the original source for context.</p>;
  }
  return <p>{quote}</p>;
}

export function ProductVariants({ value }: { value: string }) {
  return <div className="field-note"><strong>Variants</strong><EvidenceExcerpt quote={value} /></div>;
}
