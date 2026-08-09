// Role/modifier reference data, cached on disk.
//
// `/api/roles/raw` is the server's own data/roles.js, so descriptions here are
// exactly what the game implements — the point is to never guess at mechanics.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UMRest } from "./rest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "roles.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NOTES_FILE = path.join(ROOT, "data", "role-notes.json");

/**
 * Hand-written corrections for roles whose official description text misleads.
 * Each was checked against the role's card implementation upstream — the
 * descriptions describe intent, not always mechanics.
 */
function loadRoleNotes() {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
    delete notes._README;
    return notes;
  } catch {
    return {};
  }
}

export class Knowledge {
  constructor(data) {
    this.roles = data.roles || {};
    this.modifiers = data.modifiers || {};
    this.notes = loadRoleNotes();
    this.gameType = "Mafia";
  }

  note(roleName) {
    return this.notes[String(roleName || "").split(":")[0]] || null;
  }

  /** Renders a role's correction note as indented lines, if one exists. */
  noteLines(roleName, indent = "  ") {
    const note = this.note(roleName);
    if (!note) return [];
    // Render every field except bookkeeping, so a note added to the JSON is
    // never silently invisible.
    const SKIP = new Set(["verifiedIn"]);
    const LABELS = { correction: "Correction", usage: "Usage", strategy: "Strategy" };

    const out = [`${indent}** NOTE — description is misleading:`];
    for (const [key, value] of Object.entries(note)) {
      if (SKIP.has(key) || !value) continue;
      const label = LABELS[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
      for (const [i, para] of String(value).split("\n\n").entries()) {
        out.push(`${indent}   ${i === 0 ? `${label}: ` : ""}${para}`);
      }
    }
    return out;
  }

  static async load({ refresh = false, rest = new UMRest() } = {}) {
    if (!refresh && fs.existsSync(CACHE_FILE)) {
      const stat = fs.statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < MAX_AGE_MS) {
        return new Knowledge(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")));
      }
    }

    const [roles, modifiers] = await Promise.all([rest.rolesRaw(), rest.modifiers()]);
    const data = { roles, modifiers, fetchedAt: Date.now() };

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));

    return new Knowledge(data);
  }

  /** Accepts "Cop" or the wire form "Cop:Bulletproof/Humble". */
  role(name) {
    if (!name) return null;
    const bare = String(name).split(":")[0];
    const entry = (this.roles[this.gameType] || {})[bare];
    if (!entry) return null;

    return {
      name: bare,
      alignment: entry.alignment,
      category: entry.category,
      tags: entry.tags || [],
      description: [].concat(entry.description || []).join(" "),
      nightOrder: (entry.nightOrder || []).map((n) => n[0]),
      specialInteractions: entry.SpecialInteractions || null,
    };
  }

  modifier(name) {
    const list = this.modifiers[this.gameType] || [];
    const entry = list.find((m) => m.name === name);
    if (!entry) return null;
    return {
      name,
      description: [].concat(entry.description || []).join(" "),
      tags: entry.tags || [],
    };
  }

  /** Split "Cop:Bulletproof/Humble" into its role and modifier parts. */
  static splitAppearance(appearance) {
    if (!appearance) return { role: null, modifiers: [] };
    const [role, mods] = String(appearance).split(":");
    return {
      role,
      modifiers: (mods || "").split("/").filter(Boolean),
    };
  }

  /** Full human-readable writeup for one "Role:Mod/Mod" string. */
  describe(appearance) {
    const { role, modifiers } = Knowledge.splitAppearance(appearance);
    const info = this.role(role);
    const lines = [];

    if (!info) {
      lines.push(`${role} (no reference data found)`);
    } else {
      const modSuffix = modifiers.length ? ` [${modifiers.join(", ")}]` : "";
      const cat = info.category ? ` / ${info.category}` : "";
      lines.push(`${info.name}${modSuffix} — ${info.alignment}${cat}`);
      lines.push(`  ${info.description}`);
      if (info.nightOrder.length) {
        lines.push(`  Night order: ${info.nightOrder.join(", ")}`);
      }
      if (info.tags.length) lines.push(`  Tags: ${info.tags.join(", ")}`);
    }

    for (const mod of modifiers) {
      const m = this.modifier(mod);
      lines.push(`  * ${mod}: ${m ? m.description : "(no reference data)"}`);
    }

    lines.push(...this.noteLines(role));

    return lines.join("\n");
  }

  /**
   * Turn a setup's role list into a flat, described roster.
   * `setup.roles` is an array of role groups; each group maps
   * "Role:Mods" -> count. It arrives as a JSON string over REST and as a
   * real array over the socket, so both are accepted.
   */
  expandSetup(setup) {
    let groups = setup.roles;
    if (typeof groups === "string") {
      try {
        groups = JSON.parse(groups);
      } catch {
        groups = [];
      }
    }
    groups = groups || [];

    const out = [];
    groups.forEach((group, groupIndex) => {
      for (const [appearance, count] of Object.entries(group || {})) {
        const { role, modifiers } = Knowledge.splitAppearance(appearance);
        const info = this.role(role);
        out.push({
          groupIndex,
          appearance,
          role,
          modifiers,
          count,
          alignment: info ? info.alignment : "?",
          category: info ? info.category : "?",
          description: info ? info.description : "",
          nightOrder: info ? info.nightOrder : [],
        });
      }
    });

    return out;
  }

  /**
   * The phase a game actually starts in.
   *
   * `setup.startState` is NOT authoritative for Mafia — Game.calculateStateOffset
   * overwrites it with `getGameSetting("Day Start") ? "Day" : "Night"`, so the
   * stored field is stale decoration. Hollywood Illusion advertises
   * startState "Night" but has {"Day Start": true} and is genuinely daystart.
   *
   * (Host/Treasure Chest/Prologue roles can push the true first state later
   * still; those are visible in the roster.)
   */
  startState(setup) {
    if (!setup) return "?";
    if ((setup.gameType || "Mafia") === "Mafia") {
      return setup.gameSettings?.["Day Start"] ? "Day" : "Night";
    }
    return setup.startState || "?";
  }

  /** Count of each alignment in a setup — the core "what am I up against" read. */
  alignmentCounts(setup) {
    const counts = {};
    for (const entry of this.expandSetup(setup)) {
      counts[entry.alignment] = (counts[entry.alignment] || 0) + entry.count;
    }
    return counts;
  }
}
