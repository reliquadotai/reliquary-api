const DATASET_FIELDS = {
  instruction: ['prompt', 'response'],
  preference: ['prompt', 'chosen', 'rejected'],
  corpus: ['text'],
} as const;
import { DATASET_FORMATS, type DatasetFormat, type DatasetValidationReport } from './jobs.js';

/** Bounded schema inspection; reports contain counts and codes, never dataset contents. */
export async function validateDatasetBytes(
  bytes: Uint8Array,
  format: DatasetFormat,
  maxBytes = 5 * 1024 * 1024,
): Promise<DatasetValidationReport> {
  if (!DATASET_FORMATS.includes(format)) throw new Error('Invalid dataset format.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) throw new Error('Invalid validation byte limit.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  const input_sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
  const report: DatasetValidationReport = {
    schema_version: 1, input_sha256, format, rows: 0, valid: false, errors: [],
  };
  if (bytes.byteLength > maxBytes) {
    report.errors.push({ line: 0, code: 'too_large' });
    return report;
  }
  let lines: string[];
  try {
    lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter((line) => line.trim());
  } catch {
    report.errors.push({ line: 0, code: 'invalid_utf8' });
    return report;
  }
  if (!lines.length || lines.length > 10000) {
    report.errors.push({ line: 0, code: lines.length ? 'too_many_rows' : 'empty' });
    return report;
  }
  report.rows = lines.length;
  for (let i = 0; i < lines.length; i++) {
    let row: unknown;
    try { row = JSON.parse(lines[i]!); }
    catch { report.errors.push({ line: i + 1, code: 'invalid_json' }); }
    if (row !== undefined && (typeof row !== 'object' || row === null || Array.isArray(row) ||
      Object.keys(row).length !== DATASET_FIELDS[format].length ||
      !DATASET_FIELDS[format].every((field) => {
        const value = (row as Record<string, unknown>)[field];
        return typeof value === 'string' && value.trim().length >= 1 && value.length <= 32000;
      }))) report.errors.push({ line: i + 1, code: 'invalid_fields' });
    if (report.errors.length >= 20) break;
  }
  report.valid = report.errors.length === 0;
  return report;
}

export function validateJobDatasetContent(content: string, format: DatasetFormat): Promise<DatasetValidationReport> {
  if (typeof content !== 'string') throw new Error('Invalid dataset content.');
  return validateJobDatasetBytes(new TextEncoder().encode(content), format);
}

export function validateJobDatasetBytes(bytes: Uint8Array, format: DatasetFormat): Promise<DatasetValidationReport> {
  return validateDatasetBytes(bytes, format, 32768);
}
