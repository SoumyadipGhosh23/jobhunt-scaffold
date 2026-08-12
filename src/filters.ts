import { createHash } from "node:crypto";

import type { RawJob } from "./sources.js";

export type LocationTier =
  | "preferred"
  | "secondary"
  | "tertiary"
  | "remote"
  | "unknown";

export interface FilterConfig {
  locations: {
    preferred: string[];
    secondary: string[];
    tertiary: string[];
    remoteKeywords: string[];
    allowRemoteWorldwide: boolean;
    allowIndiaUnspecified: boolean;
  };
  role_keywords: {
    include: string[];
    reject: string[];
  };
}

export interface FilteredJob extends RawJob {
  fingerprint: string;
  locationTier: LocationTier;
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
  if (
    config.locations.allowRemoteWorldwide &&
    containsAny(location, config.locations.remoteKeywords)
  ) {
    return "remote";
  }
  if (containsAny(location, config.locations.preferred)) return "preferred";
  if (containsAny(location, config.locations.secondary)) return "secondary";
  if (containsAny(location, config.locations.tertiary)) return "tertiary";

  // Aggregators often return only "India" for distributed or multi-city roles.
  if (config.locations.allowIndiaUnspecified && containsKeyword(location, "india")) {
    return "tertiary";
  }
  return "unknown";
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

    jobs.push({ ...job, fingerprint, locationTier });
  }

  const tierOrder: Record<LocationTier, number> = {
    preferred: 0,
    remote: 1,
    secondary: 2,
    tertiary: 3,
    unknown: 4,
  };
  jobs.sort(
    (left, right) =>
      tierOrder[left.locationTier] - tierOrder[right.locationTier] ||
      left.company.localeCompare(right.company) ||
      left.title.localeCompare(right.title),
  );

  return { jobs, rejected };
}
