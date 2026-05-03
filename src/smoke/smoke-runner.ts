import type { SmokeCase, SmokeContext } from "./smoke-case.js";
import { createSmokeContext } from "./fixtures/shared-setup.js";

export type SmokeRunOptions = {
  tag?: string;
  id?: string;
  list?: boolean;
  failFast?: boolean;
  json?: boolean;
};

export type SmokeResult = {
  id: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
};

export type SmokeReport = {
  results: SmokeResult[];
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
};

export async function runSmokeCases(
  cases: SmokeCase[],
  options: SmokeRunOptions = {}
): Promise<SmokeReport> {
  if (options.list) {
    for (const c of cases) {
      console.log(`${c.id}  ${c.tags.join(",")}  ${c.name}`);
    }
    return { results: [], passed: 0, failed: 0, skipped: 0, durationMs: 0 };
  }

  let filtered = cases;
  if (options.tag) {
    filtered = cases.filter((c) => c.tags.includes(options.tag!));
  }
  if (options.id) {
    filtered = cases.filter((c) => c.id === options.id);
  }

  const results: SmokeResult[] = [];
  const startedAt = Date.now();

  for (const c of filtered) {
    const caseStart = Date.now();
    let context: SmokeContext | undefined;
    try {
      context = await createSmokeContext();
      await c.run(context);
      results.push({
        id: c.id,
        name: c.name,
        passed: true,
        durationMs: Date.now() - caseStart
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: c.id,
        name: c.name,
        passed: false,
        durationMs: Date.now() - caseStart,
        error: message
      });
      if (options.failFast) {
        break;
      }
    } finally {
      if (context?.sqliteDb) {
        try { context.sqliteDb.close(); } catch { /* ignore */ }
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const skippedCount = filtered.length < cases.length ? cases.length - filtered.length : 0;
  const durationMs = Date.now() - startedAt;

  const report: SmokeReport = {
    results,
    passed,
    failed: failedCount,
    skipped: skippedCount,
    durationMs
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSmokeReport(report));
  }

  return report;
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines: string[] = [
    "=== Smoke Report ===",
    `Total: ${report.results.length} | Passed: ${report.passed} | Failed: ${report.failed} | Skipped: ${report.skipped} | Duration: ${report.durationMs}ms`,
    ""
  ];

  for (const r of report.results) {
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(`[${status}] ${r.name} (${r.durationMs}ms)`);
    if (r.error) {
      lines.push(`  Error: ${r.error}`);
    }
  }

  lines.push("");
  lines.push(report.failed === 0 ? "All smoke cases passed." : `${report.failed} smoke case(s) failed.`);

  return lines.join("\n");
}

export function parseSmokeArgs(argv: string[]): SmokeRunOptions {
  const options: SmokeRunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tag" || arg === "-t") {
      options.tag = argv[++i];
    } else if (arg === "--id" || arg === "-i") {
      options.id = argv[++i];
    } else if (arg === "--list" || arg === "-l") {
      options.list = true;
    } else if (arg === "--fail-fast" || arg === "-f") {
      options.failFast = true;
    } else if (arg === "--json" || arg === "-j") {
      options.json = true;
    }
  }
  return options;
}
