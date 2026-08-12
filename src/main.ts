// Entry point. Usage: tsx src/main.ts <verify|dry-run|run>

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import yaml from "js-yaml";

import { filterAndDedupeJobs, type FilterConfig, type FilteredJob } from "./filters.js";
import { renderReport, writeReport } from "./report.js";
import {
  fetchAdzuna,
  fetchAllAtsJobs,
  fetchJooble,
  verifyAtsBoard,
  type AtsCompanies,
  type AtsProvider,
  type RawJob,
} from "./sources.js";

const CONFIG_URL = new URL("../config.yml", import.meta.url);
const COMPANIES_URL = new URL("../companies.yml", import.meta.url);
const SEEN_URL = new URL("../state/seen.json", import.meta.url);
const REPORTS_URL = new URL("../reports/", import.meta.url);

interface AppConfig extends FilterConfig {
  sources: {
    ats_boards: boolean;
    adzuna: boolean;
    jooble: boolean;
  };
  adzuna_cities: string[];
  rank: {
    max_jobs_in_report: number;
  };
}

interface SeenState {
  seen: string[];
}

interface CollectionResult {
  jobs: RawJob[];
  errorCount: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be a YAML mapping`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${path} must be a list of strings`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function loadYaml(url: URL): unknown {
  return yaml.load(readFileSync(url, "utf8"));
}

function loadConfig(): AppConfig {
  const root = requireRecord(loadYaml(CONFIG_URL), "config.yml");
  const locations = requireRecord(root.locations, "config.yml locations");
  const roleKeywords = requireRecord(root.role_keywords, "config.yml role_keywords");
  const sources = requireRecord(root.sources, "config.yml sources");
  const rank = requireRecord(root.rank, "config.yml rank");
  const adzunaCities = requireStringArray(root.adzuna_cities, "config.yml adzuna_cities");

  if (adzunaCities.length > 5) {
    throw new Error("config.yml adzuna_cities cannot contain more than 5 cities");
  }

  return {
    locations: {
      tier_a: requireStringArray(locations.tier_a, "config.yml locations.tier_a"),
      tier_b: requireStringArray(locations.tier_b, "config.yml locations.tier_b"),
      blocked: requireStringArray(locations.blocked, "config.yml locations.blocked"),
    },
    role_keywords: {
      include: requireStringArray(
        roleKeywords.include,
        "config.yml role_keywords.include",
      ),
      reject: requireStringArray(
        roleKeywords.reject,
        "config.yml role_keywords.reject",
      ),
    },
    stack_bonus: requireStringArray(root.stack_bonus, "config.yml stack_bonus"),
    sources: {
      ats_boards: requireBoolean(sources.ats_boards, "config.yml sources.ats_boards"),
      adzuna: requireBoolean(sources.adzuna, "config.yml sources.adzuna"),
      jooble: requireBoolean(sources.jooble, "config.yml sources.jooble"),
    },
    adzuna_cities: adzunaCities,
    rank: {
      max_jobs_in_report: requirePositiveInteger(
        rank.max_jobs_in_report,
        "config.yml rank.max_jobs_in_report",
      ),
    },
  };
}

function loadCompanies(): AtsCompanies {
  const root = requireRecord(loadYaml(COMPANIES_URL), "companies.yml");
  return {
    greenhouse: requireStringArray(root.greenhouse, "companies.yml greenhouse"),
    lever: requireStringArray(root.lever, "companies.yml lever"),
    ashby: requireStringArray(root.ashby, "companies.yml ashby"),
    workable: requireStringArray(root.workable, "companies.yml workable"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectJobs(config: AppConfig): Promise<CollectionResult> {
  const jobs: RawJob[] = [];
  let errorCount = 0;

  if (config.sources.ats_boards) {
    const { jobs: atsJobs, errors } = await fetchAllAtsJobs(loadCompanies());
    jobs.push(...atsJobs);
    errorCount += errors.length;
    console.log(`ATS boards: ${atsJobs.length} jobs`);
    for (const error of errors) {
      console.error(`ATS ${error.source} (${error.company}) failed: ${error.message}`);
    }
  }

  if (config.sources.adzuna) {
    const appId = requireEnv("ADZUNA_APP_ID");
    const appKey = requireEnv("ADZUNA_APP_KEY");

    for (const city of config.adzuna_cities) {
      try {
        const adzunaJobs = await fetchAdzuna(
          city,
          appId,
          appKey,
          config.role_keywords.include,
        );
        jobs.push(...adzunaJobs);
        console.log(`Adzuna (${city}): ${adzunaJobs.length} jobs`);
      } catch (error: unknown) {
        errorCount += 1;
        console.error(`Adzuna (${city}) failed: ${errorMessage(error)}`);
      }
    }
  }

  if (config.sources.jooble) {
    const joobleKey = requireEnv("JOOBLE_KEY");
    try {
      const joobleJobs = await fetchJooble(
        joobleKey,
        config.role_keywords.include,
        "India",
      );
      jobs.push(...joobleJobs);
      console.log(`Jooble: ${joobleJobs.length} jobs`);
    } catch (error: unknown) {
      errorCount += 1;
      console.error(`Jooble failed: ${errorMessage(error)}`);
    }
  }

  return { jobs, errorCount };
}

async function loadSeen(): Promise<SeenState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SEEN_URL, "utf8"));
    const root = requireRecord(parsed, "state/seen.json");
    return { seen: requireStringArray(root.seen, "state/seen.json seen") };
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") return { seen: [] };
    throw error;
  }
}

async function saveSeen(state: SeenState): Promise<void> {
  const path = SEEN_URL.pathname;
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function pruneDeadCompanies(deadBoards: ReadonlySet<string>): Promise<number> {
  if (deadBoards.size === 0) return 0;

  const path = COMPANIES_URL.pathname;
  const original = await readFile(path, "utf8");
  let currentSource: AtsProvider | undefined;
  let removed = 0;
  const providerNames = new Set<AtsProvider>([
    "greenhouse",
    "lever",
    "ashby",
    "workable",
  ]);
  const lines = original.split("\n");
  const retained = lines.filter((line) => {
    const section = /^([a-z]+):\s*(?:#.*)?$/.exec(line);
    if (section && providerNames.has(section[1] as AtsProvider)) {
      currentSource = section[1] as AtsProvider;
      return true;
    }

    const item = /^\s{2}-\s+([^#\s][^#]*?)(?:\s+#.*)?$/.exec(line);
    if (!currentSource || !item) return true;
    const company = item[1].trim().replace(/^['"]|['"]$/g, "");
    if (!deadBoards.has(`${currentSource}/${company}`)) return true;
    removed += 1;
    return false;
  });

  for (let index = 0; index < retained.length; index += 1) {
    const section = /^([a-z]+):\s*(?:#.*)?$/.exec(retained[index]);
    if (!section || !providerNames.has(section[1] as AtsProvider)) continue;

    const nextSection = retained.findIndex(
      (line, nextIndex) => nextIndex > index && /^[a-z]+:/.test(line),
    );
    const endIndex = nextSection === -1 ? retained.length : nextSection;
    const hasCompany = retained
      .slice(index + 1, endIndex)
      .some((line) => /^\s{2}-\s+/.test(line));
    const hasInlineEmptyList = retained[index].includes("[]");
    const hasSeparateEmptyList = retained
      .slice(index + 1, endIndex)
      .some((line) => /^\s+\[\]\s*(?:#.*)?$/.test(line));
    if (!hasCompany && !hasInlineEmptyList && !hasSeparateEmptyList) {
      retained[index] = `${section[1]}: []`;
    }
  }

  if (removed > 0) {
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, retained.join("\n"), "utf8");
    await rename(temporaryPath, path);
  }
  return removed;
}

function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function logFilterSummary(
  fetched: number,
  jobs: FilteredJob[],
  rejected: ReturnType<typeof filterAndDedupeJobs>["rejected"],
): void {
  console.log(
    `Filtered: ${fetched} fetched -> ${jobs.length} eligible ` +
      `(role ${rejected.role}, title ${rejected.title}, location ${rejected.location}, duplicate/seen ${rejected.duplicate})`,
  );
}

async function runDryRun(): Promise<void> {
  const config = loadConfig();
  const { jobs: rawJobs, errorCount } = await collectJobs(config);
  const result = filterAndDedupeJobs(rawJobs, config);
  logFilterSummary(rawJobs.length, result.jobs, result.rejected);

  console.log(
    renderReport(result.jobs, {
      fetched: rawJobs.length,
      eligible: result.jobs.length,
      sourceErrors: errorCount,
    }),
  );
}

async function run(): Promise<void> {
  const config = loadConfig();
  const seenState = await loadSeen();
  const { jobs: rawJobs, errorCount } = await collectJobs(config);
  const result = filterAndDedupeJobs(rawJobs, config, new Set(seenState.seen));
  logFilterSummary(rawJobs.length, result.jobs, result.rejected);

  const jobsToReport = result.jobs.slice(0, config.rank.max_jobs_in_report);
  const report = renderReport(jobsToReport, {
    fetched: rawJobs.length,
    eligible: result.jobs.length,
    sourceErrors: errorCount,
  });
  const reportUrl = new URL(`${localDate()}.md`, REPORTS_URL);
  await writeReport(reportUrl.pathname, report);
  await saveSeen({
    seen: [...new Set([...seenState.seen, ...jobsToReport.map((job) => job.fingerprint)])],
  });

  console.log(`Report: ${reportUrl.pathname}`);
  console.log(`Seen state: added ${jobsToReport.length} jobs`);
}

async function runVerify(): Promise<void> {
  const companies = loadCompanies();
  const entries = (Object.entries(companies) as Array<[AtsProvider, string[]]>).flatMap(
    ([source, sourceCompanies]) =>
      sourceCompanies.map(async (company) => ({
        source,
        company,
        result: await verifyAtsBoard(source, company),
      })),
  );
  const results = await Promise.all(entries);

  for (const { source, company, result } of results) {
    if (result.valid) {
      console.log(`OK ${source}/${company}`);
    } else {
      console.error(`FAIL ${source}/${company}: ${result.message ?? "unknown error"}`);
    }
  }

  const failures = results.filter(({ result }) => !result.valid).length;
  const confirmedDead = new Set(
    results
      .filter(({ result }) => !result.valid && result.status === 404)
      .map(({ source, company }) => `${source}/${company}`),
  );
  const pruned = await pruneDeadCompanies(confirmedDead);
  console.log(`Verified ${results.length} boards; ${failures} failed`);
  if (pruned > 0) console.log(`Pruned ${pruned} confirmed-dead boards from companies.yml`);
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "verify":
      await runVerify();
      break;
    case "dry-run":
      await runDryRun();
      break;
    case "run":
      await run();
      break;
    default:
      console.error(`Unknown command: "${process.argv[2] ?? ""}"`);
      console.error("Usage: tsx src/main.ts <verify|dry-run|run>");
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
