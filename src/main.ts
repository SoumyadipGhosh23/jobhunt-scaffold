// Entry point. Usage: tsx src/main.ts <verify|dry-run|run>

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";

import yaml from "js-yaml";

import { filterAndDedupeJobs, type FilterConfig } from "./filters.js";
import { rankJobs, type RankConfig, type RankedJob } from "./rank.js";
import { renderReport, writeReport } from "./report.js";
import { loadResume } from "./resume.js";
import {
  fetchAdzuna,
  fetchAllAtsJobs,
  fetchHnHiring,
  fetchJooble,
  fetchRemotive,
  fetchRemoteOk,
  verifyAtsBoard,
  type AtsCompanies,
  type AtsProvider,
  type RawJob,
} from "./sources.js";

const PROJECT_URL = new URL("../", import.meta.url);
const CONFIG_URL = new URL("config.yml", PROJECT_URL);
const COMPANIES_URL = new URL("companies.yml", PROJECT_URL);
const SEEN_URL = new URL("state/seen.json", PROJECT_URL);
const REPORTS_URL = new URL("reports/", PROJECT_URL);

interface SourceConfig {
  atsBoards: boolean;
  adzuna: boolean;
  jooble: boolean;
  remotive: boolean;
  remoteOk: boolean;
  hnHiring: boolean;
}

interface AppConfig extends FilterConfig {
  resumePath: string;
  sources: SourceConfig;
  adzunaCities: string[];
  joobleLocations: string[];
  rank: RankConfig & {
    provider: "deepseek";
    maxJobsInReport: number;
  };
}

interface SeenState {
  seen: string[];
}

interface CollectionResult {
  jobs: RawJob[];
  errorCount: number;
}

interface SearchResult {
  fetched: number;
  deterministicEligible: number;
  sourceErrors: number;
  jobs: RankedJob[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadLocalEnv(): void {
  try {
    loadEnvFile(new URL(".env", PROJECT_URL));
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

loadLocalEnv();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be a YAML mapping`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function requireRelativePath(value: unknown, path: string): string {
  const result = requireString(value, path);
  if (result.startsWith("/") || result.split(/[\\/]/).includes("..")) {
    throw new Error(`${path} must stay within the project root`);
  }
  return result;
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

function requireNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${path} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const result = requireNumber(value, path, 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function loadYaml(url: URL): unknown {
  return yaml.load(readFileSync(url, "utf8"));
}

function loadConfig(): AppConfig {
  const root = requireRecord(loadYaml(CONFIG_URL), "config.yml");
  const resume = requireRecord(root.resume, "config.yml resume");
  const locations = requireRecord(root.locations, "config.yml locations");
  const roleKeywords = requireRecord(root.role_keywords, "config.yml role_keywords");
  const salary = requireRecord(root.salary, "config.yml salary");
  const sources = requireRecord(root.sources, "config.yml sources");
  const rank = requireRecord(root.rank, "config.yml rank");
  const adzunaCities = requireStringArray(root.adzuna_cities, "config.yml adzuna_cities");

  if (adzunaCities.length > 5) {
    throw new Error("config.yml adzuna_cities cannot contain more than 5 cities");
  }
  if (requireString(rank.provider, "config.yml rank.provider") !== "deepseek") {
    throw new Error("config.yml rank.provider must be deepseek");
  }
  if (requireBoolean(sources.email_bridge, "config.yml sources.email_bridge")) {
    throw new Error("config.yml sources.email_bridge is not implemented yet");
  }

  return {
    resumePath: requireRelativePath(resume.path, "config.yml resume.path"),
    locations: {
      preferred: requireStringArray(
        locations.preferred,
        "config.yml locations.preferred",
      ),
      secondary: requireStringArray(
        locations.secondary,
        "config.yml locations.secondary",
      ),
      tertiary: requireStringArray(
        locations.tertiary,
        "config.yml locations.tertiary",
      ),
      remoteKeywords: requireStringArray(
        locations.remote_keywords,
        "config.yml locations.remote_keywords",
      ),
      allowRemoteWorldwide: requireBoolean(
        locations.allow_remote_worldwide,
        "config.yml locations.allow_remote_worldwide",
      ),
      allowIndiaUnspecified: requireBoolean(
        locations.allow_india_unspecified,
        "config.yml locations.allow_india_unspecified",
      ),
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
    sources: {
      atsBoards: requireBoolean(sources.ats_boards, "config.yml sources.ats_boards"),
      adzuna: requireBoolean(sources.adzuna, "config.yml sources.adzuna"),
      jooble: requireBoolean(sources.jooble, "config.yml sources.jooble"),
      remotive: requireBoolean(sources.remotive, "config.yml sources.remotive"),
      remoteOk: requireBoolean(sources.remoteok, "config.yml sources.remoteok"),
      hnHiring: requireBoolean(sources.hn_hiring, "config.yml sources.hn_hiring"),
    },
    adzunaCities,
    joobleLocations: requireStringArray(
      root.jooble_locations,
      "config.yml jooble_locations",
    ),
    rank: {
      provider: "deepseek",
      model: requireString(rank.model, "config.yml rank.model"),
      minScoreToReport: requireNumber(
        rank.min_score_to_report,
        "config.yml rank.min_score_to_report",
        0,
        100,
      ),
      secondaryMinScore: requireNumber(
        rank.secondary_min_score,
        "config.yml rank.secondary_min_score",
        0,
        100,
      ),
      tertiaryMinScore: requireNumber(
        rank.tertiary_min_score,
        "config.yml rank.tertiary_min_score",
        0,
        100,
      ),
      candidateLimit: requirePositiveInteger(
        rank.candidate_limit,
        "config.yml rank.candidate_limit",
      ),
      batchSize: requirePositiveInteger(rank.batch_size, "config.yml rank.batch_size"),
      maxJobsInReport: requirePositiveInteger(
        rank.max_jobs_in_report,
        "config.yml rank.max_jobs_in_report",
      ),
      salary: {
        minimumLpa: requireNumber(
          salary.minimum_lpa,
          "config.yml salary.minimum_lpa",
          0,
          1_000,
        ),
        preferredLpa: requireNumber(
          salary.preferred_lpa,
          "config.yml salary.preferred_lpa",
          0,
          1_000,
        ),
        allowUndisclosed: requireBoolean(
          salary.allow_undisclosed,
          "config.yml salary.allow_undisclosed",
        ),
      },
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

  if (config.sources.atsBoards) {
    const { jobs: atsJobs, errors } = await fetchAllAtsJobs(loadCompanies());
    jobs.push(...atsJobs);
    errorCount += errors.length;
    console.log(`ATS boards: ${atsJobs.length} jobs`);
    for (const error of errors) {
      console.error(`ATS ${error.source} (${error.company}) failed: ${error.message}`);
    }
  }

  const requests: Array<{ label: string; promise: Promise<RawJob[]> }> = [];
  if (config.sources.adzuna) {
    const appId = requireEnv("ADZUNA_APP_ID");
    const appKey = requireEnv("ADZUNA_APP_KEY");
    for (const city of config.adzunaCities) {
      requests.push({
        label: `Adzuna (${city})`,
        promise: fetchAdzuna(city, appId, appKey, config.role_keywords.include),
      });
    }
  }
  if (config.sources.jooble) {
    const key = requireEnv("JOOBLE_KEY");
    for (const location of config.joobleLocations) {
      requests.push({
        label: `Jooble (${location})`,
        promise: fetchJooble(key, config.role_keywords.include, location),
      });
    }
  }
  if (config.sources.remotive) {
    requests.push({ label: "Remotive", promise: fetchRemotive() });
  }
  if (config.sources.remoteOk) {
    requests.push({ label: "Remote OK", promise: fetchRemoteOk() });
  }
  if (config.sources.hnHiring) {
    requests.push({ label: "HN Who is hiring", promise: fetchHnHiring() });
  }

  const results = await Promise.all(
    requests.map(async ({ label, promise }) => {
      try {
        return { label, jobs: await promise };
      } catch (error: unknown) {
        return { label, jobs: [], error: errorMessage(error) };
      }
    }),
  );
  for (const result of results) {
    if (result.error) {
      errorCount += 1;
      console.error(`${result.label} failed: ${result.error}`);
    } else {
      jobs.push(...result.jobs);
      console.log(`${result.label}: ${result.jobs.length} jobs`);
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
    const sectionLines = retained.slice(index + 1, endIndex);
    const hasCompany = sectionLines.some((line) => /^\s{2}-\s+/.test(line));
    const hasEmptyList =
      retained[index].includes("[]") ||
      sectionLines.some((line) => /^\s+\[\]\s*(?:#.*)?$/.test(line));
    if (!hasCompany && !hasEmptyList) retained[index] = `${section[1]}: []`;
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

async function search(config: AppConfig, seen: ReadonlySet<string>): Promise<SearchResult> {
  const apiKey = requireEnv("DEEPSEEK_API_KEY");
  const resumeUrl = new URL(config.resumePath, PROJECT_URL);
  const [resume, collection] = await Promise.all([
    loadResume(resumeUrl),
    collectJobs(config),
  ]);
  console.log(`Resume: ${config.resumePath} (${resume.length} extracted characters)`);

  const filtered = filterAndDedupeJobs(collection.jobs, config, seen);
  console.log(
    `Filtered: ${collection.jobs.length} fetched -> ${filtered.jobs.length} eligible ` +
      `(role ${filtered.rejected.role}, title ${filtered.rejected.title}, duplicate/seen ${filtered.rejected.duplicate})`,
  );

  const ranked = await rankJobs(apiKey, resume, filtered.jobs, config.rank);
  console.log(
    `DeepSeek: ${Math.min(filtered.jobs.length, config.rank.candidateLimit)} ranked -> ${ranked.jobs.length} reportable; ${ranked.usage.totalTokens} tokens`,
  );
  return {
    fetched: collection.jobs.length,
    deterministicEligible: filtered.jobs.length,
    sourceErrors: collection.errorCount,
    jobs: ranked.jobs,
    usage: ranked.usage,
  };
}

function reportFor(result: SearchResult, config: AppConfig): string {
  const jobs = result.jobs.slice(0, config.rank.maxJobsInReport);
  return renderReport(jobs, {
    fetched: result.fetched,
    eligible: result.deterministicEligible,
    ranked: result.jobs.length,
    sourceErrors: result.sourceErrors,
    deepSeekTokens: result.usage.totalTokens,
  });
}

async function runDryRun(): Promise<void> {
  const config = loadConfig();
  const result = await search(config, new Set());
  console.log(reportFor(result, config));
}

async function run(): Promise<void> {
  const config = loadConfig();
  const seenState = await loadSeen();
  const result = await search(config, new Set(seenState.seen));
  const jobsToReport = result.jobs.slice(0, config.rank.maxJobsInReport);
  const reportUrl = new URL(`${localDate()}.md`, REPORTS_URL);
  await writeReport(reportUrl.pathname, reportFor(result, config));
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
    if (result.valid) console.log(`OK ${source}/${company}`);
    else console.error(`FAIL ${source}/${company}: ${result.message ?? "unknown error"}`);
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
