// The Multica CLI's profiles, and choosing one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The profiles that hold a token, by name: `""` is the default profile. `multica auth logout`
 * leaves a config without a token, and an unreadable config logs nobody in.
 */
export const listProfiles = (home: string): string[] => {
  const root = join(home, ".multica");
  const dir = join(root, "profiles");
  const configs: [string, string][] = [["", join(root, "config.json")]];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).toSorted()) {
      configs.push([name, join(dir, name, "config.json")]);
    }
  }
  return configs
    .filter(([, config]) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(config, "utf8"));
        return !!parsed && typeof parsed === "object" && "token" in parsed && !!parsed.token;
      } catch {
        return false;
      }
    })
    .map(([name]) => name);
};

/**
 * The profile to use: the one given, the only one there is, or the one the person picks. Throws
 * when there are several and no terminal to ask in.
 */
export const pickProfile = async (
  home: string,
  given: string | undefined,
  ask: ((question: string) => Promise<string>) | undefined,
  log: (line: string) => void,
): Promise<string> => {
  if (given !== undefined) return given;
  const found = listProfiles(home);
  if (found.length === 0) {
    throw new Error(
      "no logged-in Multica CLI profile under ~/.multica: log in with the Desktop app or `multica login`",
    );
  }
  if (found.length === 1) return found[0] ?? "";
  if (!ask) {
    const names = found.map((name) => name || '"" for the default').join(", ");
    throw new Error(`several Multica profiles: pass --profile <name> (${names})`);
  }
  found.forEach((name, index) => log(`  ${index + 1}. ${name || "(default)"}`));
  const answer = await ask("Profile (number): ");
  const picked = found[Number(answer) - 1];
  if (picked === undefined) throw new Error(`no profile ${answer}`);
  return picked;
};
