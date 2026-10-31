/**
 * Parse an invoice with a Zod schema. `values` is typed from the schema.
 *
 *   DOC2JSON_API_KEY=... npx tsx examples/zod.ts path/to/invoice.pdf
 */
import { Doc2Json } from "@manoonlabs/doc2json";
import { z } from "zod";

const Invoice = z.object({
  vendor: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  issued: z.iso.date().nullable().describe("The invoice date"),
  total: z.number().nullable(),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number() })),
});

const doc2json = new Doc2Json();
const result = await doc2json.parse(process.argv[2] ?? "invoice.pdf", { schema: Invoice });

const total: number | null = result.values.total;
console.log(`${result.values.vendor ?? "Unknown vendor"}: ${total ?? "no total"}`);

if (!result.validation.success) {
  console.warn("values did not match the schema:", result.validation.error.issues);
}
