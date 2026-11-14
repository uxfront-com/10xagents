// Copies the repository's setups/ into the package, so the published CLI ships them.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../setups", import.meta.url));
const to = fileURLToPath(new URL("../setups", import.meta.url));

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
