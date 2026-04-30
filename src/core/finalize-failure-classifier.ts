import {
  FinalizeFailureClass,
  FinalizeFailureDiagnostic,
  FinalizerFailureDetails,
  TaskValidationEvidenceManifest,
  ValidationOutputSummary,
} from '../types/task';

const OUTPUT_SUMMARY_EXCERPT_LIMIT = 2000;

export interface QualityGateFailureInput {
  requestedScript: string;
  actualScript: string;
  cwd: string;
  packageLabel: string;
  command: string;
  rawMessage: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  timedOut?: boolean;
  startFailed?: boolean;
}

export class QualityGateFailure extends Error {
  readonly details: FinalizerFailureDetails;
  readonly validationEvidence?: TaskValidationEvidenceManifest;

  constructor(details: FinalizerFailureDetails, validationEvidence?: TaskValidationEvidenceManifest) {
    super(details.rawMessage);
    this.name = 'QualityGateFailure';
    this.details = details;
    this.validationEvidence = validationEvidence;
  }
}

export function isQualityGateFailure(error: unknown): error is QualityGateFailure {
  return error instanceof QualityGateFailure;
}

export function classifyQualityGateFailure(input: QualityGateFailureInput): FinalizerFailureDetails {
  const combinedOutput = [input.stdout?.trim(), input.stderr?.trim()]
    .filter(Boolean)
    .join('\n')
    .trim();
  const diagnostics = parseDiagnostics(combinedOutput);
  const failureClass = resolveFailureClass(input, diagnostics, combinedOutput);
  const failedFiles = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.file).filter(isNonEmptyString));
  const failedCodes = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.code).filter(isNonEmptyString));
  const failedSymbols = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.symbol).filter(isNonEmptyString));
  const diagnosticSignature = diagnostics.length > 0
    ? diagnostics
        .map((diagnostic) => [
          diagnostic.file || '',
          diagnostic.line ?? '',
          diagnostic.column ?? '',
          diagnostic.code || '',
          diagnostic.severity,
          diagnostic.message,
        ].join(':'))
        .sort()
        .join('\n')
    : undefined;

  return {
    failureKind: 'quality_gate',
    class: failureClass,
    gate: input.actualScript,
    requestedGate: input.requestedScript,
    packageLabel: input.packageLabel,
    cwd: input.cwd,
    command: input.command,
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : undefined,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    timedOut: input.timedOut || undefined,
    startFailed: input.startFailed || undefined,
    stdoutSummary: summarizeValidationOutput(input.stdout),
    stderrSummary: summarizeValidationOutput(input.stderr),
    diagnosticCount: diagnostics.length > 0 ? diagnostics.length : undefined,
    diagnosticSignature,
    failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
    failedCodes: failedCodes.length > 0 ? failedCodes : undefined,
    failedSymbols: failedSymbols.length > 0 ? failedSymbols : undefined,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    rawMessage: input.rawMessage,
  };
}

export function summarizeValidationOutput(output: string | undefined): ValidationOutputSummary {
  const content = output ?? '';
  const byteLength = Buffer.byteLength(content, 'utf-8');
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const trimmed = content.trim();
  const excerptSource = trimmed || content;
  const truncated = excerptSource.length > OUTPUT_SUMMARY_EXCERPT_LIMIT;
  const excerpt = truncated
    ? excerptSource.slice(excerptSource.length - OUTPUT_SUMMARY_EXCERPT_LIMIT)
    : excerptSource;

  return {
    byteLength,
    lineCount,
    truncated,
    excerpt: excerpt || undefined,
  };
}

function parseDiagnostics(output: string): FinalizeFailureDiagnostic[] {
  if (!output) {
    return [];
  }

  const diagnostics: FinalizeFailureDiagnostic[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/i);
    if (tsMatch) {
      const message = tsMatch[6].trim();
      diagnostics.push({
        file: tsMatch[1].trim(),
        line: Number(tsMatch[2]),
        column: Number(tsMatch[3]),
        severity: tsMatch[4].toLowerCase() === 'warning' ? 'warning' : 'error',
        code: tsMatch[5].trim(),
        symbol: extractSymbol(message),
        message,
      });
    }
  }

  return diagnostics;
}

function resolveFailureClass(
  input: QualityGateFailureInput,
  diagnostics: FinalizeFailureDiagnostic[],
  output: string,
): FinalizeFailureClass {
  if (input.timedOut) {
    return 'quality_gate_timeout';
  }

  if (input.startFailed) {
    return 'quality_gate_start_failure';
  }

  if (diagnostics.length === 0) {
    return output ? 'quality_gate_failure' : 'unknown';
  }

  const messages = diagnostics.map((diagnostic) => diagnostic.message);

  if (messages.some((message) => (
    /object literal may only specify known properties/i.test(message)
    || /does not exist in type/i.test(message)
    || /property '.+' does not exist on type/i.test(message)
  ))) {
    return 'generated_type_drift';
  }

  if (messages.some((message) => /is not assignable to type/i.test(message) && /"[^"]+"/.test(message))) {
    return 'enum_drift';
  }

  if (messages.some((message) => (
    /a type predicate's type must be assignable/i.test(message)
    || /no overload matches this call/i.test(message)
    || /is not assignable to type/i.test(message)
  ))) {
    return 'domain_type_mismatch';
  }

  return 'typescript_diagnostics';
}

function extractSymbol(message: string): string | undefined {
  const quotedMatches = [
    message.match(/'([A-Za-z0-9_$.:-]+)'/),
    message.match(/"([A-Za-z0-9_$.:-]+)"/),
    message.match(/Property '([A-Za-z0-9_$.:-]+)'/),
  ];

  for (const match of quotedMatches) {
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
