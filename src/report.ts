import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RankedJob } from "./rank.js";

export interface ReportSummary {
  fetched: number;
  eligible: number;
  ranked: number;
  sourceErrors: number;
  deepSeekTokens: number;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function compactDescription(value: string, maxLength = 360): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function tierLabel(tier: RankedJob["locationTier"]): string {
  if (tier === "preferred") return "First choice";
  if (tier === "secondary") return "Second choice";
  if (tier === "tertiary") return "Third choice";
  if (tier === "remote") return "Remote worldwide";
  return "Location requires review";
}

function list(values: string[], emptyLabel: string): string {
  return values.length ? values.map(escapeMarkdown).join(", ") : emptyLabel;
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return undefined;
  }
}

export function renderReport(
  jobs: RankedJob[],
  summary: ReportSummary,
  generatedAt: Date = new Date(),
): string {
  const timestamp = generatedAt.toISOString();
  const sections = jobs.map((job, index) => {
    const title = escapeMarkdown(job.title || "Untitled role");
    const company = escapeMarkdown(job.company || "Unknown company");
    const location = escapeMarkdown(job.location || "Unspecified");
    const salary = escapeMarkdown(job.salaryAssessment || job.salaryText || "Not disclosed");
    const url = safeUrl(job.url);
    const titleLine = url
      ? `## ${index + 1}. [${title}](${url}) — ${company}`
      : `## ${index + 1}. ${title} — ${company}`;

    return [
      titleLine,
      "",
      `- Match score: **${job.score}/100**`,
      `- Location: ${location} (${tierLabel(job.locationTier)})`,
      `- Location assessment: ${escapeMarkdown(job.locationAssessment)}`,
      `- Compensation: ${salary} (${job.salaryFit})`,
      `- Matched resume skills: ${list(job.matchedSkills, "None identified")}`,
      `- Missing or weaker skills: ${list(job.missingSkills, "None material")}`,
      `- Source: ${job.source}`,
      "",
      escapeMarkdown(job.reason),
      "",
      escapeMarkdown(compactDescription(job.description)) ||
        "No description supplied by source.",
    ].join("\n");
  });

  return [
    `# Job Hunt Report — ${timestamp.slice(0, 10)}`,
    "",
    `Generated at ${timestamp}`,
    "",
    `Fetched ${summary.fetched} jobs; ${summary.eligible} passed deterministic filters; ${summary.ranked} passed DeepSeek ranking; ${summary.sourceErrors} source requests failed.`,
    `DeepSeek usage: ${summary.deepSeekTokens} tokens.`,
    "",
    sections.length ? sections.join("\n\n---\n\n") : "No new matching jobs found.",
    "",
  ].join("\n");
}

export async function writeReport(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
