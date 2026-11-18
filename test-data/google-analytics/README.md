# Google Analytics public test samples

These are unchanged copies of the user's CSV exports from Google's
[`ga4_obfuscated_sample_ecommerce` public dataset](https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset),
which represents obfuscated Google Merchandise Store activity. They are test
data, not a merchant's verified financial records. No credentials or raw user
identifiers are included in these exports.

## Files and expected results

- **`purchase-items.csv`**: 13,218 purchase-item rows; 4,451 distinct order IDs;
  789 SKUs; 81 recorded sales dates, November 11, 2020–January 30, 2021.
  Select **USD**. Sum(quantity × unit_price) is **307,774 USD** before any
  unprovided discounts/refunds/costs. Missing transaction IDs were excluded and
  repeated transaction events deduplicated by the source query. It does not
  include refund history or prove payment settlement.
- **`daily-traffic.csv`**: 92 daily rows, November 1, 2020–January 31, 2021;
  360,974 recorded sessions; 4,851 purchasing sessions; 4,295,584 events;
  zero reported events without session keys. Weighted conversion is
  **4,851 / 360,974 × 100 = approximately 1.3438641%**. Do not sum daily
  `user_count` into a period's unique-user count.

The two files have **81 overlapping dates**, not identical coverage. The eleven
traffic-only dates must not create zero-valued or fabricated sales. Purchasing
sessions are not order counts, so the two totals are not forced to agree.

## Try them locally

1. Sign in, create a separate **Google Merchandise Store (public sample)**
   business, and open **Growth Simulator → My sales**.
2. Choose **Import sales**, select USD, upload `purchase-items.csv`, review and
   confirm. This replaces only that business's imported sales baseline.
3. Choose **Import website visits**, name the source, upload `daily-traffic.csv`,
   confirm that it describes the same business/channel, then confirm the import.
4. Inspect the traffic chart and conversion rate. By default all 92 traffic
   dates are shown; **Use selected sales date range** narrows the traffic view to
   the selected dates without deleting other traffic.

Either file can be imported first. A traffic-only workspace does not acquire
sales, currency, orders, or revenue. Unrelated dates (for example the 2010–2011
UCI retail sample) are rejected when pairing sources; use separate businesses.
Matching dates alone do not prove source identity, which still requires owner
confirmation. No GA account connection is performed.

`server/traffic.test.ts` exercises these exact files with isolated test databases,
not the normal app database.
