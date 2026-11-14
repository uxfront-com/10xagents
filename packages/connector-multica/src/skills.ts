// Skill folders: checking them against what Multica's import keeps, and zipping them for it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32 } from "node:zlib";

import type { ConnectorIssue, RenderedSkill } from "10xagents";

import { norm } from "./text.ts";

/** Every file under `dir`, as absolute paths, sorted, without `.DS_Store`. */
const walk = (dir: string): string[] =>
  readdirSync(dir)
    .toSorted()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (entry === ".DS_Store") return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

const posix = (path: string): string => path.split(sep).join("/");

/** A skill's files, by path inside its folder, each normalised as Multica stores it. */
export const skillFiles = (skill: RenderedSkill): Map<string, string> =>
  new Map(
    walk(skill.dir).map((path) => [
      posix(relative(skill.dir, path)),
      norm(readFileSync(path, "utf8")),
    ]),
  );

/** The `name` in a SKILL.md's frontmatter, or `""`. */
export const frontmatterName = (text: string): string =>
  /^---\r?\n([\s\S]*?\r?\n)---/
    .exec(text)?.[1]
    ?.match(/^name:[ \t]*(.*)$/m)?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2") ?? "";

const BINARY =
  /\.(png|jpe?g|gif|webp|bmp|tiff|ico|heic|ttf|otf|woff2?|eot|zip|gz|tar|bz2|7z|rar|pdf|docx?|xlsx?|pptx?|mp3|mp4|wav|avi|mov|webm|m4a|flac|exe|dll|so|dylib|class|jar|wasm|db|sqlite3?|pyc)$/i;

/**
 * A file Multica's import leaves out: dotfiles, a second `skill.md`, licences and binaries
 * (`skill_import_archive.go`, `skill/binary.go`). The sync compares every file, so a file like
 * that would show as a change on every run.
 */
export const leftOut = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith(".")) ||
  (path !== "SKILL.md" && /(^|\/)skill\.md$/i.test(path)) ||
  /(^|\/)license(\.md|\.txt)?$/i.test(path) ||
  BINARY.test(path);

/**
 * What Multica's import would change about a skill: a SKILL.md that's missing or names another
 * skill, and files it would leave out.
 */
export const checkSkill = (skill: RenderedSkill): ConnectorIssue[] => {
  const issues: ConnectorIssue[] = [];
  const at = (path: string) => join(skill.dir, path);
  let files: string[];
  try {
    files = walk(skill.dir).map((path) => posix(relative(skill.dir, path)));
  } catch (error) {
    return [
      {
        file: skill.dir,
        field: "(dir)",
        message: `can't be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  if (!files.includes("SKILL.md")) {
    issues.push({
      file: at("SKILL.md"),
      field: "(file)",
      message: "is missing: every skill needs one",
    });
  } else {
    const named = frontmatterName(readFileSync(at("SKILL.md"), "utf8"));
    if (named !== skill.name) {
      issues.push({
        file: at("SKILL.md"),
        field: "name",
        message: named
          ? `must be ${skill.name}, like its folder (it says ${named}): Multica names a skill after it`
          : `is missing: write name: ${skill.name}, like its folder`,
      });
    }
  }
  for (const path of files) {
    if (leftOut(path)) {
      issues.push({
        file: at(path),
        field: "(file)",
        message: "Multica leaves this file out of an import: rename or remove it",
      });
    }
  }
  return issues;
};

/** A zip of the skill's folder, stored without compression, with the folder at its root. */
export const zipSkill = (skill: RenderedSkill): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for (const path of walk(skill.dir)) {
    const name = Buffer.from(`${skill.name}/${posix(relative(skill.dir, path))}`);
    const data = readFileSync(path);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
    count++;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};
