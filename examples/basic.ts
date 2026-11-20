/**
 * Parse an invoice and print the total, with citations.
 *
 *   DOXTRACT_API_KEY=... npx tsx examples/basic.ts path/to/invoice.pdf
 */
import { Doxtract, DoxtractError } from "@manoonlabs/doxtract";

type Invoice = {
  vendor: string | null;
  invoiceNumber: string | null;
  total: number | null;
  lineItems: { description: string; amount: number }[];
};

const doxtract = new Doxtract();
const path = process.argv[2] ?? "invoice.pdf";

try {
  const result = await doxtract.parse<Invoice>(path, {
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
} catch (error) {
  if (error instanceof DoxtractError) {
    console.error(`${error.name} (${error.status ?? "no response"}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
