/**
 * robots.txt ayrıştırıcı ve denetleyici (RFC 9309). Kimlik belirteci (`UniversalMail`) için özel grup varsa o, yoksa
 * `*` grubu uygulanır. Eşleşmede en uzun kural kazanır; eşitlikte `Allow` kazanır. `*` ve `$` desteklenir.
 */
interface Rule {
  allow: boolean;
  pattern: string;
}

const MAX_RULES = 5000;
const MAX_PATTERN = 500;
const MAX_PATH = 2048;

/**
 * Kural deseni yol ile eşleşiyor mu? `*` herhangi bir diziyi, sonda `$` yol sonunu eşler. robots.txt içeriği
 * karşı tarafın denetiminde olduğundan düzenli ifade KULLANILMAZ (iç içe `*` ile üstel geri izleme saldırısı olur);
 * açgözlü iki göstergeli doğrusal-ikinci dereceden algoritma kullanılır.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const s = path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== "*" && p[pi] === s[si]) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else if (!anchored && pi === p.length) {
      return true; // desen tükendi; sonda $ yoksa önek eşleşmesi yeter
    } else return false;
    if (!anchored && pi === p.length) return true;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

export class RobotsPolicy {
  private constructor(
    private readonly rules: Rule[],
    /** Sitenin istediği bekleme (ms); yoksa null. */
    readonly crawlDelayMs: number | null,
  ) {}

  static allowAll(): RobotsPolicy {
    return new RobotsPolicy([], null);
  }

  static parse(text: string, agentToken: string): RobotsPolicy {
    const token = agentToken.toLowerCase();
    type Group = { agents: string[]; rules: Rule[]; delay: number | null };
    const groups: Group[] = [];
    let current: Group | null = null;
    let lastWasAgent = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "user-agent") {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [], delay: null };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!current) continue;
      if (key === "allow" || key === "disallow") {
        if (value === "" && key === "disallow") continue; // boş Disallow = her şeye izin
        if (value.length <= MAX_PATTERN && current.rules.length < MAX_RULES)
          current.rules.push({ allow: key === "allow", pattern: value });
      } else if (key === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.delay = n * 1000;
      }
    }
    const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
    const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
    const rules = chosen.flatMap((g) => g.rules);
    const delay = chosen.map((g) => g.delay).find((d) => d !== null) ?? null;
    return new RobotsPolicy(rules, delay);
  }

  isAllowed(pathAndQuery: string): boolean {
    let best: Rule | null = null;
    for (const r of this.rules) {
      if (!matchesPattern(r.pattern, pathAndQuery)) continue;
      if (
        !best ||
        r.pattern.length > best.pattern.length ||
        (r.pattern.length === best.pattern.length && r.allow && !best.allow)
      )
        best = r;
    }
    return best ? best.allow : true;
  }
}
