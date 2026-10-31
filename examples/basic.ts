/**
 * Parse an invoice and print the total, with citations.
 *
 *   DOC2JSON_API_KEY=... npx tsx examples/basic.ts path/to/invoice.pdf
 */
import { Doc2Json, Doc2JsonError } from "@manoonlabs/doc2json";

type Invoice = {
  vendor: string | null;
  invoiceNumber: string | null;
  total: number | null;
  lineItems: { description: string; amount: number }[];
};

const doc2json = new Doc2Json();
const path = process.argv[2] ?? "invoice.pdf";

try {
  const result = await doc2json.parse<Invoice>(path, {
    schema: {
      type: "object",
      properties: {
        vendor: { type: "string" },
        invoiceNumber: { type: "string" },
        total: { type: "number" },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
            },
          },
        },
      },
    },
    citations: true,
  });

  console.log(result.values);
  console.log("total was read from:", result.citations?.total);
  console.log(`credits used: ${result.credits_used}, left: ${result.credits_remaining}`);
} catch (error) {
  if (error instanceof Doc2JsonError) {
    console.error(`${error.name} (${error.status ?? "no response"}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
