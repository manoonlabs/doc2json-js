import { expect, it } from "vitest";
import {
  normalizeSchemaSlug,
  resolveSchemaSlug,
  schemaSlugFromDisplayName,
} from "../src/schema-slug";

it("normalizeSchemaSlug folds hyphens to underscores", () => {
  expect(normalizeSchemaSlug("bank-statement")).toBe("bank_statement");
});

it("schemaSlugFromDisplayName builds the API slug from a display name", () => {
  expect(schemaSlugFromDisplayName("Bank Statement")).toBe("bank_statement");
});

it("resolveSchemaSlug prefers an already valid slug", () => {
  expect(resolveSchemaSlug("invoice")).toBe("invoice");
});

it("resolveSchemaSlug derives a slug when the input is a display name", () => {
  expect(resolveSchemaSlug("My Invoice")).toBe("my_invoice");
});
