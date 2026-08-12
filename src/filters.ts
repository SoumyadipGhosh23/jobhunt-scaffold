import { createHash } from "node:crypto";

import type { RawJob } from "./sources.js";

export type LocationTier = "a" | "b" | "remote";

export interface FilterConfig {
  locations: {
    tier_a: string[];
    tier_b: string[];
    blocked: string[];
  };
  role_keywords: {
    include: string[];
    reject: string[];
  };
  stack_bonus: string[];
}

export interface FilteredJob extends RawJob {
  fingerprint: string;
  locationTier: LocationTier;
  stackMatches: string[];
}

export interface FilterResult {
  jobs: FilteredJob[];
  rejected: {
    duplicate: number;
    location: number;
    role: number;
    title: number;
  };
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsKeyword(value: string, keyword: string): boolean {
  const normalizedValue = ` ${normalize(value)} `;
  const normalizedKeyword = normalize(keyword);
  return normalizedKeyword.length > 0 && normalizedValue.includes(` ${normalizedKeyword} `);
}

function containsAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => containsKeyword(value, keyword));
}

function classifyLocation(location: string, config: FilterConfig): LocationTier | null {
  const remoteKeywords = ["remote", "worldwide", "work from home", "wfh"];
  if (containsAny(location, remoteKeywords)) return "remote";
  if (containsAny(location, config.locations.blocked)) return null;
  if (containsAny(location, config.locations.tier_a)) return "a";
  if (containsAny(location, config.locations.tier_b)) return "b";

  // Aggregators often return only "India" for distributed or multi-city roles.
  if (containsKeyword(location, "india")) return "b";
  return null;
}

export function jobFingerprint(job: RawJob): string {
  const identity = [job.company, job.title, job.location].map(normalize).join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function filterAndDedupeJobs(
  rawJobs: RawJob[],
  config: FilterConfig,
  seen: ReadonlySet<string> = new Set(),
): FilterResult {
  const rejected: FilterResult["rejected"] = {
    duplicate: 0,
    location: 0,
    role: 0,
    title: 0,
  };
  const fingerprints = new Set(seen);
  const jobs: FilteredJob[] = [];

  for (const job of rawJobs) {
    if (!containsAny(job.title, config.role_keywords.include)) {
      rejected.role += 1;
      continue;
    }

    if (containsAny(job.title, config.role_keywords.reject)) {
      rejected.title += 1;
      continue;
    }

    const locationTier = classifyLocation(job.location, config);
    if (!locationTier) {
      rejected.location += 1;
      continue;
    }

    const fingerprint = jobFingerprint(job);
    if (fingerprints.has(fingerprint)) {
      rejected.duplicate += 1;
      continue;
    }
    fingerprints.add(fingerprint);

    const searchableText = `${job.title} ${job.description}`;
    const stackMatches = config.stack_bonus.filter((keyword) =>
      containsKeyword(searchableText, keyword),
    );

    jobs.push({ ...job, fingerprint, locationTier, stackMatches });
  }

  const tierOrder: Record<LocationTier, number> = { a: 0, remote: 1, b: 2 };
  jobs.sort(
    (left, right) =>
      tierOrder[left.locationTier] - tierOrder[right.locationTier] ||
      right.stackMatches.length - left.stackMatches.length ||
      left.company.localeCompare(right.company) ||
      left.title.localeCompare(right.title),
  );

  return { jobs, rejected };
}
