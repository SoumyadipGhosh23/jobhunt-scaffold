import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { PDFParse } from "pdf-parse";

const MINIMUM_RESUME_LENGTH = 200;

function redactContactDetails(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone redacted]")
    .replace(/https?:\/\/\S+/gi, "[url redacted]");
}

function normalizeResume(text: string): string {
  return redactContactDetails(text)
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readPdf(path: URL): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(await readFile(path)) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function loadResume(path: URL): Promise<string> {
  const extension = extname(path.pathname).toLowerCase();
  const text = extension === ".pdf" ? await readPdf(path) : await readFile(path, "utf8");
  const normalized = normalizeResume(text);

  if (normalized.length < MINIMUM_RESUME_LENGTH) {
    throw new Error(`Resume text is too short or unreadable: ${path.pathname}`);
  }
  return normalized;
}
