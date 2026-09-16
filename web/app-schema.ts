/**
 * The shape of a catalog app's questions, and what a fresh install starts from.
 *
 * TrueNAS's app.create takes `values` in the shape the questions describe,
 * and every question may carry a default. Installing "with defaults" means
 * building that object from the schema — which is what the NAS's own UI
 * does before it shows a form. Kept apart from the form so it can be tested
 * without a DOM.
 */

export interface Question {
  variable: string;
  label?: string;
  description?: string;
  group?: string;
  schema: QSchema;
}

export interface QSchema {
  type: string;
  default?: unknown;
  required?: boolean;
  private?: boolean;
  enum?: Array<{ value: string; description?: string }>;
  attrs?: Question[];
  items?: Question[];
  min?: number;
  max?: number;
  hidden?: boolean;
  editable?: boolean;
  /** A dict may declare that it should be absent unless another value says otherwise. */
  show_if?: unknown;
}

/**
 * The values object a schema describes, filled with its defaults.
 *
 * A dict becomes an object of its children's defaults. A leaf takes its own
 * default, or nothing — an absent key is what the NAS reads as "use the
 * chart's default", and inventing an empty string would not be. Lists start
 * as their declared default or empty.
 */
export function defaultsFor(questions: Question[] | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions ?? []) {
    const value = defaultOf(q.schema);
    if (value !== undefined) out[q.variable] = value;
  }
  return out;
}

function defaultOf(s: QSchema | undefined): unknown {
  if (!s) return undefined;
  if (s.type === "dict") {
    const inner = defaultsFor(s.attrs);
    // A dict with an explicit default (usually {}) and no populated children
    // is still a dict; the NAS wants the object, not its absence.
    return Object.keys(inner).length || s.default !== undefined ? { ...((s.default as object) ?? {}), ...inner } : {};
  }
  if (s.type === "list") return Array.isArray(s.default) ? s.default : [];
  return s.default;
}

/** True when the schema asks nothing worth a form: every question hidden or absent. */
export function hasVisibleQuestions(questions: Question[] | null | undefined): boolean {
  return (questions ?? []).some((q) => !q.schema?.hidden);
}
