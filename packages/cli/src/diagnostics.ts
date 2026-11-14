// Errors found in a setup, each tied to a file and a field.

import { relative } from "node:path";

export interface Diagnostic {
  /** The absolute path of the file, or a label like `(built-in default template)`. */
  file: string;
  /** The field, like `description`, `sections.role` or `body`. */
  field: string;
  message: string;
}

/** Collects diagnostics, once each, in the order they were found. */
export class Diagnostics {
  readonly #seen = new Set<string>();
  readonly list: Diagnostic[] = [];

  add(file: string, field: string, message: string): void {
    const key = `${file}\0${field}\0${message}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.list.push({ file, field, message });
  }

  get size(): number {
    return this.list.length;
  }
}

/** `<file>: <field>: <message>`, with the file relative to `cwd`. */
export const formatDiagnostic = (diagnostic: Diagnostic, cwd: string = process.cwd()): string => {
  const file = diagnostic.file.startsWith("/")
    ? relative(cwd, diagnostic.file) || diagnostic.file
    : diagnostic.file;
  return `${file}: ${diagnostic.field}: ${diagnostic.message}`;
};
