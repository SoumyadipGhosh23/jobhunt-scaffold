export type AtsProvider = "greenhouse" | "lever" | "ashby" | "workable";
export type JobSource =
  | AtsProvider
  | "adzuna"
  | "jooble"
  | "remotive"
  | "remoteok"
  | "hn_hiring";

export interface RawJob {
  source: JobSource;
  company: string;
  id: string;
  title: string;
  location: string;
  url: string;
  description: string;
  salaryText?: string;
}

export interface AtsCompanies {
  greenhouse: string[];
  lever: string[];
  ashby: string[];
  workable: string[];
}

export interface SourceError {
  source: AtsProvider;
  company: string;
  message: string;
}

export interface AtsFetchResult {
  jobs: RawJob[];
  errors: SourceError[];
}

const REQUEST_TIMEOUT_MS = 15_000;

interface GreenhouseJob {
  id?: string | number;
  title?: string;
  absolute_url?: string;
  content?: string;
  location?: { name?: string };
}

interface LeverJob {
  id?: string;
  text?: string;
  hostedUrl?: string;
  description?: string;
  descriptionPlain?: string;
  categories?: { location?: string };
  lists?: Array<{ content?: string; text?: string }>;
}

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  jobUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
}

interface WorkableJob {
  id?: string | number;
  shortcode?: string;
  title?: string;
  location?: string | { city?: string; country?: string };
  city?: string;
  state?: string;
  country?: string;
  telecommuting?: boolean;
  workplace_type?: "on_site" | "hybrid" | "remote";
  application_url?: string;
  url?: string;
  description?: string;
  full_description?: string;
}

interface AdzunaJob {
  id?: string | number;
  title?: string;
  redirect_url?: string;
  description?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
}

interface JoobleJob {
  id?: string | number;
  title?: string;
  company?: string;
  location?: string;
  link?: string;
  snippet?: string;
  salary?: string;
}

interface RemotiveJob {
  id?: string | number;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  url?: string;
  description?: string;
  salary?: string;
}

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  description?: string;
  salary_min?: number;
  salary_max?: number;
}

interface AlgoliaHit {
  objectID?: string;
  title?: string;
  story_id?: number;
  comment_text?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray<T>(value: unknown, key?: string): T[] {
  const candidate = key && isRecord(value) ? value[key] : value;
  return Array.isArray(candidate) ? (candidate as T[]) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function annualSalaryText(
  minimum: number | undefined,
  maximum: number | undefined,
  currency: string,
): string | undefined {
  if (minimum === undefined && maximum === undefined) return undefined;
  if (minimum !== undefined && maximum !== undefined) {
    return `${currency} ${minimum}-${maximum} per year`;
  }
  return `${currency} ${minimum ?? maximum} per year`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const codePoint = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
}

export function stripHtml(value: unknown): string {
  if (typeof value !== "string") return "";

  return decodeHtmlEntities(value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(
  url: string,
  init?: RequestInit,
  errorContext: string = url,
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${response.status} ${response.statusText} for ${errorContext}`,
    );
  }

  return response.json() as Promise<unknown>;
}

async function fetchGreenhouse(company: string): Promise<RawJob[]> {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs?content=true`,
  );

  return recordArray<GreenhouseJob>(data, "jobs").map((job, index) => ({
    source: "greenhouse",
    company,
    id: String(job.id ?? index),
    title: job.title ?? "",
    location: job.location?.name ?? "",
    url: job.absolute_url ?? "",
    description: stripHtml(job.content),
  }));
}

async function fetchLever(company: string): Promise<RawJob[]> {
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`,
  );

  return recordArray<LeverJob>(data).map((job, index) => ({
    source: "lever",
    company,
    id: String(job.id ?? index),
    title: job.text ?? "",
    location: job.categories?.location ?? "",
    url: job.hostedUrl ?? "",
    description: stripHtml(
      job.descriptionPlain ??
        job.description ??
        job.lists?.map((item) => `${item.text ?? ""} ${stripHtml(item.content)}`).join(" "),
    ),
  }));
}

async function fetchAshby(company: string): Promise<RawJob[]> {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`,
  );

  return recordArray<AshbyJob>(data, "jobs").map((job, index) => ({
    source: "ashby",
    company,
    id: String(job.id ?? index),
    title: job.title ?? "",
    location: job.location ?? "",
    url: job.jobUrl ?? "",
    description: stripHtml(job.descriptionPlain ?? job.descriptionHtml),
  }));
}

function workableLocation(job: WorkableJob): string {
  if (job.telecommuting || job.workplace_type === "remote") return "Remote";
  if (typeof job.location === "string") return job.location;
  if (job.location) {
    return [job.location.city, job.location.country].filter(Boolean).join(", ");
  }
  return [job.city, job.state, job.country].filter(Boolean).join(", ");
}

async function fetchWorkable(company: string): Promise<RawJob[]> {
  const data = await fetchJson(
    `https://www.workable.com/api/accounts/${encodeURIComponent(company)}?details=true`,
  );

  const jobs = Array.isArray(data)
    ? (data as WorkableJob[])
    : recordArray<WorkableJob>(data, "jobs");

  return jobs.map((job, index) => ({
    source: "workable",
    company,
    id: String(job.id ?? job.shortcode ?? index),
    title: job.title ?? "",
    location: workableLocation(job),
    url: job.application_url ?? job.url ?? "",
    description: stripHtml(job.full_description ?? job.description),
  }));
}

const atsFetchers: Record<AtsProvider, (company: string) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
};

export async function fetchAllAtsJobs(companies: AtsCompanies): Promise<AtsFetchResult> {
  const requests = (Object.entries(companies) as Array<[AtsProvider, string[]]>).flatMap(
    ([source, sourceCompanies]) =>
      sourceCompanies.map(async (company) => {
        try {
          return { jobs: await atsFetchers[source](company) };
        } catch (error: unknown) {
          return {
            jobs: [],
            error: { source, company, message: errorMessage(error) },
          };
        }
      }),
  );

  const results = await Promise.all(requests);
  return {
    jobs: results.flatMap((result) => result.jobs),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}

export async function verifyAtsBoard(
  source: AtsProvider,
  company: string,
): Promise<{ valid: boolean; message?: string; status?: number }> {
  try {
    await atsFetchers[source](company);
    return { valid: true };
  } catch (error: unknown) {
    return {
      valid: false,
      message: errorMessage(error),
      status: error instanceof HttpError ? error.status : undefined,
    };
  }
}

// --- Adzuna ---
// https://api.adzuna.com/v1/api/jobs/in/search/1
// Free tier: 1000 calls/month. We call once per city (max 5), so ~150/month.
export async function fetchAdzuna(
  city: string,
  appId: string,
  appKey: string,
  keywords: string[],
): Promise<RawJob[]> {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    where: city,
    what_or: keywords.join(" "),
    results_per_page: "50",
  });

  const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?${params.toString()}`;
  const data = await fetchJson(url, undefined, "Adzuna");

  return recordArray<AdzunaJob>(data, "results").map((job, index) => ({
    source: "adzuna",
    company: job.company?.display_name ?? "unknown",
    id: String(job.id ?? index),
    title: job.title ?? "",
    location: job.location?.display_name ?? city,
    url: job.redirect_url ?? "",
    description: stripHtml(job.description),
    salaryText: annualSalaryText(job.salary_min, job.salary_max, "INR"),
  }));
}

// --- Jooble ---
// POST https://jooble.org/api/{key}
export async function fetchJooble(
  key: string,
  keywords: string[],
  location: string,
): Promise<RawJob[]> {
  const data = await fetchJson(
    `https://jooble.org/api/${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: keywords.join(" "), location }),
    },
    "Jooble",
  );

  return recordArray<JoobleJob>(data, "jobs").map((job, index) => ({
    source: "jooble",
    company: job.company ?? "unknown",
    id: String(job.id ?? index),
    title: job.title ?? "",
    location: job.location ?? location,
    url: job.link ?? "",
    description: stripHtml(job.snippet),
    salaryText: job.salary,
  }));
}

// --- Remotive ---
// Public listings are delayed by 24 hours and must link back to Remotive.
export async function fetchRemotive(): Promise<RawJob[]> {
  const params = new URLSearchParams({ category: "software-dev", limit: "200" });
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?${params.toString()}`,
    undefined,
    "Remotive",
  );

  return recordArray<RemotiveJob>(data, "jobs").map((job, index) => ({
    source: "remotive",
    company: job.company_name ?? "unknown",
    id: String(job.id ?? index),
    title: job.title ?? "",
    location: job.candidate_required_location
      ? `Remote — ${job.candidate_required_location}`
      : "Remote",
    url: job.url ?? "",
    description: stripHtml(job.description),
    salaryText: job.salary,
  }));
}

// --- Remote OK ---
// The first API item is a legal notice and is intentionally skipped.
export async function fetchRemoteOk(): Promise<RawJob[]> {
  const data = await fetchJson(
    "https://remoteok.com/api",
    { headers: { "User-Agent": "jobhunt/1.0" } },
    "Remote OK",
  );

  return recordArray<RemoteOkJob>(data)
    .slice(1)
    .map((job, index) => ({
      source: "remoteok",
      company: job.company ?? "unknown",
      id: String(job.id ?? job.slug ?? index),
      title: job.position ?? "",
      location: job.location ? `Remote — ${job.location}` : "Remote",
      url: job.apply_url ?? job.url ?? "",
      description: stripHtml(job.description),
      salaryText: annualSalaryText(job.salary_min, job.salary_max, "USD"),
    }));
}

function latestHiringStoryId(data: unknown): string | undefined {
  const stories = recordArray<AlgoliaHit>(data, "hits");
  return stories.find((story) => /ask hn:\s*who is hiring/i.test(story.title ?? ""))
    ?.objectID;
}

// --- Hacker News: Ask HN, Who is hiring? ---
export async function fetchHnHiring(): Promise<RawJob[]> {
  const storyParams = new URLSearchParams({
    tags: "story,ask_hn",
    query: "Ask HN: Who is hiring?",
    hitsPerPage: "10",
  });
  const stories = await fetchJson(
    `https://hn.algolia.com/api/v1/search_by_date?${storyParams.toString()}`,
    undefined,
    "HN Algolia",
  );
  const storyId = latestHiringStoryId(stories);
  if (!storyId) throw new Error("HN Algolia did not return a current hiring thread");

  const commentParams = new URLSearchParams({
    tags: `comment,story_${storyId}`,
    hitsPerPage: "1000",
  });
  const comments = await fetchJson(
    `https://hn.algolia.com/api/v1/search?${commentParams.toString()}`,
    undefined,
    "HN Algolia",
  );

  return recordArray<AlgoliaHit>(comments, "hits").map((comment, index) => {
    const description = stripHtml(comment.comment_text);
    const header = description.split(/\s+\|\s+/).slice(0, 4);
    return {
      source: "hn_hiring" as const,
      company: header[0]?.slice(0, 80) || "HN employer",
      id: String(comment.objectID ?? index),
      title: header.join(" | ").slice(0, 180) || "HN Who is hiring posting",
      location: header.join(" | ").slice(0, 240) || "Unspecified",
      url: `https://news.ycombinator.com/item?id=${comment.objectID ?? storyId}`,
      description,
    };
  }).filter(
    (job) =>
      !/^location\s*:/i.test(job.description) &&
      !/\bwilling to relocate\b/i.test(job.description) &&
      !/\bseeking (?:a |an )?(?:job|role|position)\b/i.test(job.description),
  );
}
