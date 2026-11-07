import { Doc2JsonError } from "./errors";

export const SCHEMA_NAME_MAX_LENGTH = 80;
const CUSTOM_SCHEMA_LABEL = "__custom_schema";
const SCHEMA_DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9 _-]*[a-zA-Z0-9])?$/;
const SCHEMA_SLUG_SOURCE_PATTERN = /^[a-z0-9_]+$/;

/** Saved schema display name: trimmed, collapsed whitespace, NFKC. */
export function normalizeSchemaDisplayName(input: string): string | null {
  const collapsed = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (
    !collapsed ||
    collapsed.length > SCHEMA_NAME_MAX_LENGTH ||
    !SCHEMA_DISPLAY_NAME_PATTERN.test(collapsed)
  ) {
    return null;
  }
  if (collapsed === CUSTOM_SCHEMA_LABEL) return null;
  return collapsed;
}

/**
 * API slug: lowercase letters, digits, underscores. Hyphens become
 * underscores so `bank-statement` matches `bank_statement`.
 */
export function normalizeSchemaSlug(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/-/g, "_");
  if (!SCHEMA_SLUG_SOURCE_PATTERN.test(trimmed) || trimmed.length > SCHEMA_NAME_MAX_LENGTH) {
    return null;
  }
  if (trimmed === CUSTOM_SCHEMA_LABEL) return null;
  return trimmed;
}

/** Display name to slug, e.g. "My Invoice" → `my_invoice`. */
export function schemaSlugFromDisplayName(display: string): string | null {
  const normalized = normalizeSchemaDisplayName(display);
  if (!normalized) return null;
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (
    !slug ||
    slug.length > SCHEMA_NAME_MAX_LENGTH ||
    !SCHEMA_SLUG_SOURCE_PATTERN.test(slug) ||
    slug === CUSTOM_SCHEMA_LABEL
  ) {
    return null;
  }
  return slug;
}

/** Path or parse reference: slug first, else derive from a display name. */
export function resolveSchemaSlug(input: string): string {
  const slug = normalizeSchemaSlug(input) ?? schemaSlugFromDisplayName(input);
  if (!slug) {
    throw new Doc2JsonError(`Invalid schema slug: ${input.trim().slice(0, 80)}`, {
      code: "invalid_input",
    });
  }
  return slug;
}
