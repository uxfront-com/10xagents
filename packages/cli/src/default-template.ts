// The built-in `default` template. A setup's `templates/default.md` replaces it.

import { toTemplate } from "./loader.ts";
import type { Template } from "./loader.ts";

export const BUILT_IN_FILE = "(built-in default template)";

export const DEFAULT_TEMPLATE: Template = toTemplate(
  "default",
  BUILT_IN_FILE,
  {
    slots: {
      role: { heading: "Role", required: true },
      "how-you-work": { heading: "How you work", required: false },
      boundaries: { heading: "Boundaries", required: false },
      "ask-or-stop": { heading: "When to ask or stop", required: false },
      "before-handback": { heading: "Before you hand back", required: false },
      handback: { heading: "What you hand back", required: true },
    },
  },
  [
    "# {{agent.name}}",
    "{{slot:role}}",
    "{{slot:how-you-work}}",
    "{{slot:boundaries}}",
    "{{slot:ask-or-stop}}",
    "{{slot:before-handback}}",
    "{{slot:handback}}",
    "{{global}}",
  ].join("\n\n"),
);

/** The templates the CLI ships, by id. */
export const BUILT_IN_TEMPLATES: ReadonlyMap<string, Template> = new Map([
  ["default", DEFAULT_TEMPLATE],
]);
