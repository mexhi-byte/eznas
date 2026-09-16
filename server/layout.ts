/**
 * Which pool layout to suggest for the drives that are present.
 *
 * The pool dialog knows the minimum member count for each layout and nothing
 * else, so a first-time owner with five drives is shown five choices and a
 * word each. This says what each choice costs and buys in the units they
 * think in — usable space and how many drives may die — and picks one. Pure,
 * so the rule can be tested without a NAS and read without running it.
 */

export interface Drive {
  name: string;
  size: number;
  type?: string;
}

export type Layout = "STRIPE" | "MIRROR" | "RAIDZ1" | "RAIDZ2" | "RAIDZ3";

export interface LayoutOption {
  layout: Layout;
  /** Bytes a person can put in it, before ZFS's own overhead. */
  usable: number;
  /** Drives that can fail before data is lost. */
  survives: number;
  /** One sentence for the person choosing. */
  summary: string;
  /** Why it is or is not the pick. */
  note: string;
  recommended: boolean;
}

const MIN: Record<Layout, number> = { STRIPE: 1, MIRROR: 2, RAIDZ1: 3, RAIDZ2: 4, RAIDZ3: 5 };

/**
 * Every layout the drives allow, with the recommended one marked.
 *
 * The rule: with one drive there is only a stripe, and it is said plainly
 * that it protects nothing. Two or three drives mirror. Four to seven are
 * RAIDZ2 — one parity drive is not enough when a resilver of a large drive
 * takes days and the second failure comes during it. Eight or more are
 * RAIDZ2 as well; RAIDZ3 is offered, not pushed. Mixed sizes are used at the
 * size of the smallest, and the waste is named.
 */
export function recommendLayouts(drives: Drive[]): LayoutOption[] {
  const n = drives.length;
  if (!n) return [];
  const smallest = Math.min(...drives.map((d) => d.size));
  const wasted = drives.reduce((s, d) => s + (d.size - smallest), 0);
  const mixed =
    wasted > 0 ? ` Drives are used at the size of the smallest, so ${fmt(wasted)} across them goes unused.` : "";
  const pick: Layout = n === 1 ? "STRIPE" : n <= 3 ? "MIRROR" : "RAIDZ2";

  const options: LayoutOption[] = [];
  for (const layout of Object.keys(MIN) as Layout[]) {
    if (n < MIN[layout]) continue;
    const parity = layout === "RAIDZ1" ? 1 : layout === "RAIDZ2" ? 2 : layout === "RAIDZ3" ? 3 : 0;
    const usable = layout === "MIRROR" ? smallest : layout === "STRIPE" ? smallest * n : smallest * (n - parity);
    const survives = layout === "MIRROR" ? n - 1 : parity;
    const summary =
      layout === "STRIPE"
        ? `${fmt(usable)} of space, and any one drive failing loses everything.`
        : layout === "MIRROR"
          ? `${fmt(usable)} of space. Every drive holds a full copy; survives ${survives} failing.`
          : `${fmt(usable)} of space. Survives ${survives} drive${survives === 1 ? "" : "s"} failing at once.`;
    let note = "";
    if (layout === pick) {
      note =
        n === 1
          ? "The only layout one drive allows. Add a second and mirror it before anything irreplaceable lives here."
          : n <= 3
            ? "Mirrors rebuild fastest after a failure and are the simplest to grow: add another pair."
            : "Two drives of parity, because a rebuild of a large drive takes days and the second failure tends to come during it.";
    } else if (layout === "STRIPE") note = "No protection. Only for data that can be downloaded again.";
    else if (layout === "RAIDZ1") note = "One parity drive. Fine for small drives; risky above about 4 TB each.";
    else if (layout === "RAIDZ3")
      note = "Three parity drives. For pools of ten or more, or drives that are hard to replace quickly.";
    else if (layout === "MIRROR") note = `Half the space of RAIDZ2 with ${n} drives, but the fastest rebuilds.`;
    else if (layout === "RAIDZ2") note = "Two parity drives. The usual choice from four drives up.";
    options.push({ layout, usable, survives, summary: summary + mixed, note, recommended: layout === pick });
  }
  return options;
}

function fmt(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = v >= 100 || i === 0 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${units[i]}`;
}
