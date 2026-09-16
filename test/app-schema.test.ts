import { describe, expect, it } from "vitest";
import { defaultsFor, hasVisibleQuestions, type Question } from "../web/app-schema.js";

// A cut-down shape of what catalog.get_app_details returns for a real app.
const QUESTIONS: Question[] = [
  {
    variable: "network",
    schema: {
      type: "dict",
      attrs: [
        { variable: "web_port", schema: { type: "int", default: 30027 } },
        { variable: "host_network", schema: { type: "boolean", default: false } },
      ],
    },
  },
  {
    variable: "storage",
    schema: {
      type: "dict",
      attrs: [
        {
          variable: "config",
          schema: {
            type: "dict",
            attrs: [
              { variable: "type", schema: { type: "string", default: "ix_volume" } },
              { variable: "host_path", schema: { type: "string" } },
            ],
          },
        },
        { variable: "additional_storage", schema: { type: "list", default: [], items: [] } },
      ],
    },
  },
  { variable: "timezone", schema: { type: "string", default: "Etc/UTC" } },
  { variable: "ix_context", schema: { type: "dict", hidden: true, attrs: [] } },
];

describe("defaultsFor", () => {
  it("builds the values object from nested defaults", () => {
    expect(defaultsFor(QUESTIONS)).toEqual({
      network: { web_port: 30027, host_network: false },
      storage: { config: { type: "ix_volume" }, additional_storage: [] },
      timezone: "Etc/UTC",
      ix_context: {},
    });
  });

  /*
   * A leaf with no default is left out rather than set to "". The NAS reads
   * an absent key as "use the chart's default"; an empty string is a value,
   * and for a host path it is an invalid one.
   */
  it("leaves out a leaf with no default", () =>
    expect(defaultsFor(QUESTIONS).storage).not.toHaveProperty(["config", "host_path"]));

  it("copes with nothing", () => {
    expect(defaultsFor(null)).toEqual({});
    expect(defaultsFor([])).toEqual({});
  });
});

describe("hasVisibleQuestions", () => {
  it("is false when every question is hidden, so the dialog can say so", () => {
    expect(hasVisibleQuestions([{ variable: "ix_context", schema: { type: "dict", hidden: true } }])).toBe(false);
    expect(hasVisibleQuestions(null)).toBe(false);
  });
  it("is true when anything would be shown", () => expect(hasVisibleQuestions(QUESTIONS)).toBe(true));
});
