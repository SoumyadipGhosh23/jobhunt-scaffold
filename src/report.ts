import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FilteredJob } from "./filters.js";

export interface ReportSummary {
  fetched: number;
  eligible: number;
  sourceErrors: number;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function compactDescription(value: string, maxLength = 420): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function tierLabel(tier: FilteredJob["locationTier"]): string {
  if (tier === "a") return "Tier A";
  if (tier === "b") return "Tier B — ranking gate applies";
  return "Remote";
}

export function renderReport(
  jobs: FilteredJob[],
  summary: ReportSummary,
  generatedAt: Date = new Date(),
): string {
  const timestamp = generatedAt.toISOString();
  const sections = jobs.map((job, index) => {
    const title = escapeMarkdown(job.title || "Untitled role");
    const company = escapeMarkdown(job.company || "Unknown company");
    const location = escapeMarkdown(job.location || "Unspecified");
    const stack = job.stackMatches.length
      ? job.stackMatches.map(escapeMarkdown).join(", ")
      : "No configured stack keywords found";
    const description = compactDescription(job.description);
    const titleLine = job.url
      ? `## ${index + 1}. [${title}](${job.url}) — ${company}`
      : `## ${index + 1}. ${title} — ${company}`;

    return [
      titleLine,
      "",
      `- Location: ${location} (${tierLabel(job.locationTier)})`,
      `- Source: ${job.source}`,
      `- Stack matches: ${stack}`,
      "",
      description || "No description supplied by source.",
    ].join("\n");
  });

  return [
    `# Job Hunt Report — ${timestamp.slice(0, 10)}`,
    "",
    `Generated at ${timestamp}`,
    "",
    `Fetched ${summary.fetched} jobs; ${summary.eligible} passed deterministic filters; ${summary.sourceErrors} source requests failed.`,
    "",
    sections.length ? sections.join("\n\n---\n\n") : "No new matching jobs found.",
    "",
  ].join("\n");
}

export async function writeReport(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
