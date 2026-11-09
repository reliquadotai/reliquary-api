// Scores of a graded evaluation: the summary on a catalog evaluation order and on an evaluation on a
// customer's file (order.evaluation.summary), and the per-environment metrics of report.json.
export type EvaluationMetrics = {
  n_problems: number; samples: number; complete: boolean;
  n_problems_graded: number | null; missing_problems: number | null; expected_rows: number | null; graded_rows: number | null;
  ungraded_rows: number | null; missing_rows: number | null;
  requested_samples: number | null; attempted_samples: number | null; completed_samples: number | null; graded_samples: number | null;
  mean_score: number | null; truncation_rate: number | null;
  format_failure_rate: number | null; mean_completion_tokens: number | null; mean_turns: number | null;
  tool_calls_total: number | null; stop_reasons: Record<string, number> | null;
  'pass@1': { value: number; ci95: [number, number] }; 'pass@k': Record<string, number>;
};
export type EvaluationSummary = { complete: boolean; envs: Record<string, EvaluationMetrics>; macro: { 'pass@1': number; 'pass@k': Record<string, number> } };

const fail = (): never => { throw new Error('Invalid evaluation response.'); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const text = (v: unknown, max = 200): string => typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : fail();
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : fail();
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(v) ? number(v, min, max) : fail();
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
const nullable = <T>(v: unknown, parse: (value: unknown) => T): T | null => v == null ? null : parse(v);
// Summary keys are environment ids (verifiers:aime25) or, for an evaluation on a file, the grader.
const envKey = (v: unknown): string => /^\w[\w.:-]{0,127}$/.test(text(v, 128)) ? v as string : fail();

const rates = (value: unknown, report = false): Record<string, number> => Object.fromEntries(Object.entries(record(value)).map(([key, raw]) => {
  if (!/^[1-9][0-9]*$/.test(key)) fail();
  return [key, number(report ? record(raw)['value'] : raw, 0, 1)];
}));

/** One environment's metrics; `report` reads report.json's {value, n_problems} pass@k entries. */
export function parseEvaluationMetrics(value: unknown, report = false): EvaluationMetrics {
  const v = record(value), pass = record(v['pass@1']), ci = list(pass['ci95'], 2).map(x => number(x, 0, 1));
  if (ci.length !== 2 || ci[0]! > ci[1]!) fail();
  const result = { n_problems: integer(v['n_problems']), samples: integer(v['samples'], 1, 64), complete: bool(v['complete']), 'pass@1': { value: number(pass['value'], 0, 1), ci95: ci as [number, number] }, 'pass@k': rates(v['pass@k'], report) } as EvaluationMetrics;
  for (const key of ['n_problems_graded', 'missing_problems', 'expected_rows', 'graded_rows', 'ungraded_rows', 'missing_rows', 'requested_samples', 'attempted_samples', 'completed_samples', 'graded_samples', 'tool_calls_total'] as const) result[key] = nullable(v[key], x => integer(x));
  for (const key of ['mean_score', 'truncation_rate', 'format_failure_rate', 'mean_completion_tokens', 'mean_turns'] as const) result[key] = nullable(v[key], x => number(x, 0, key.endsWith('_rate') ? 1 : Number.MAX_SAFE_INTEGER));
  result.stop_reasons = nullable(v['stop_reasons'], x => Object.fromEntries(Object.entries(record(x)).map(([k, n]) => [text(k, 100), integer(n)])));
  if (result.n_problems_graded !== null && result.n_problems_graded > result.n_problems) fail();
  if (result.expected_rows !== null && result.graded_rows !== null && result.ungraded_rows !== null && result.missing_rows !== null && result.expected_rows !== result.graded_rows + result.ungraded_rows + result.missing_rows) fail();
  return result;
}

/** A result summary: per-environment metrics (keyed by environment, or by grader for a file) and the macro. */
export function parseEvaluationSummary(value: unknown, report = false): EvaluationSummary {
  const v = record(value), macro = record(v['macro']);
  return { complete: bool(v['complete']), envs: Object.fromEntries(Object.entries(record(v['envs'])).map(([env, raw]) => [envKey(env), parseEvaluationMetrics(raw, report)])), macro: { 'pass@1': number(macro['pass@1'], 0, 1), 'pass@k': rates(macro['pass@k']) } };
}
