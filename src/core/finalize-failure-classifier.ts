import {
  FinalizeFailureClass,
  FinalizeFailureDiagnostic,
  FinalizerFailureDetails,
  PackageGateFailure,
} from '../types/task';
import * as path from 'path';

export interface QualityGateFailureInput {
  requestedScript: string;
  actualScript: string;
  cwd: string;
  packageLabel: string;
  command: string;
  preparationCommands?: string[];
  validationCommands?: string[];
  rawMessage: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  startFailed?: boolean;
  taskId?: string;
  taskWorktree?: string;
  repoPath?: string;
}

export class QualityGateFailure extends Error {
  readonly details: FinalizerFailureDetails;

  constructor(details: FinalizerFailureDetails) {
    super(details.rawMessage);
    this.name = 'QualityGateFailure';
    this.details = details;
  }
}

export function isQualityGateFailure(error: unknown): error is QualityGateFailure {
  return error instanceof QualityGateFailure;
}

export function classifyQualityGateFailure(input: QualityGateFailureInput): FinalizerFailureDetails {
  const combinedOutput = [input.rawMessage?.trim(), input.stdout?.trim(), input.stderr?.trim()]
    .filter(Boolean)
    .join('\n')
    .trim();
  const diagnosticOutput = [input.stdout?.trim(), input.stderr?.trim()]
    .filter(Boolean)
    .join('\n')
    .trim() || input.rawMessage;
  const nestedFailures = parseTurboNestedFailures({
    output: combinedOutput,
    taskWorktree: input.taskWorktree,
    repoPath: input.repoPath,
    parentCommand: input.command,
  });
  const primaryNestedFailure = shouldUseNestedFailure(input, nestedFailures[0])
    ? nestedFailures[0]
    : undefined;
  const diagnostics = uniqueDiagnostics(parseDiagnostics(diagnosticOutput));
  const failureClass = resolveFailureClass(input, diagnostics, combinedOutput);
  const failedFiles = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.file).filter(isNonEmptyString));
  const failedCodes = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.code).filter(isNonEmptyString));
  const failedSymbols = uniqueStrings(diagnostics.map((diagnostic) => diagnostic.symbol).filter(isNonEmptyString));
  const failedTests = parseFailedTests(combinedOutput);
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
    class: primaryNestedFailure
      ? resolveNestedFailureClass(failureClass, combinedOutput)
      : failureClass,
    gate: primaryNestedFailure?.gate ?? input.actualScript,
    requestedGate: input.requestedScript,
    packageLabel: primaryNestedFailure?.packageLabel ?? input.packageLabel,
    cwd: primaryNestedFailure?.cwd ?? input.cwd,
    command: primaryNestedFailure?.command ?? input.command,
    preparationCommands: input.preparationCommands?.length ? input.preparationCommands : undefined,
    validationCommands: input.validationCommands?.length ? input.validationCommands : undefined,
    parentCommand: primaryNestedFailure ? input.command : undefined,
    parentCwd: primaryNestedFailure ? input.cwd : undefined,
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : undefined,
    timedOut: input.timedOut || undefined,
    startFailed: input.startFailed || undefined,
    diagnosticCount: diagnostics.length > 0 ? diagnostics.length : undefined,
    diagnosticSignature,
    failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
    failedCodes: failedCodes.length > 0 ? failedCodes : undefined,
    failedSymbols: failedSymbols.length > 0 ? failedSymbols : undefined,
    failedTests: failedTests.length > 0 ? failedTests : undefined,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    nestedFailures: nestedFailures.length > 0 ? nestedFailures : undefined,
    rawMessage: input.rawMessage,
  };
}

export function parseTurboNestedFailures(input: {
  output: string;
  taskWorktree?: string;
  repoPath?: string;
  parentCommand: string;
}): PackageGateFailure[] {
  if (!input.output) {
    return [];
  }

  const failures: PackageGateFailure[] = [];
  const seen = new Set<string>();
  const lines = input.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const pattern = /(?:^|\s)([A-Za-z0-9_.@/-]+)[#:]([A-Za-z0-9_.:-]+):.*?command \(([^)]+)\)\s+(.+?)\s+exited\s+\((\d+)\)/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    const cwd = path.resolve(match[3].trim());
    const gate = normalizeGateName(match[2]);
    const packageLabel = normalizePackageLabelFromCwd(cwd, input.taskWorktree, input.repoPath)
      ?? match[1].trim();
    const command = normalizeCommand(match[4].trim());
    const key = [packageLabel, gate, cwd, command].join('\0');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    failures.push({
      packageLabel,
      packageName: match[1].trim(),
      gate,
      cwd,
      command,
      exitCode: Number(match[5]),
      source: 'turbo_nested_failure',
      rawMessage: line,
    });
  }

  return failures;
}

function shouldUseNestedFailure(
  input: QualityGateFailureInput,
  nestedFailure: PackageGateFailure | undefined,
): boolean {
  if (!nestedFailure) {
    return false;
  }

  const inputCwd = path.resolve(input.cwd);
  const taskWorktree = input.taskWorktree ? path.resolve(input.taskWorktree) : undefined;
  const repoPath = input.repoPath ? path.resolve(input.repoPath) : undefined;

  if (input.packageLabel === input.taskId) {
    return true;
  }

  if (taskWorktree && inputCwd === taskWorktree) {
    return true;
  }

  if (taskWorktree && input.packageLabel === path.basename(taskWorktree)) {
    return true;
  }

  if (repoPath && inputCwd === repoPath) {
    return true;
  }

  return (
    input.packageLabel !== nestedFailure.packageLabel
    && inputCwd !== path.resolve(nestedFailure.cwd)
    && /(?:^|\s)(turbo|pnpm|npm|yarn|bun)\s+run\s+/i.test(input.command)
  );
}

function normalizePackageLabelFromCwd(
  cwd: string,
  taskWorktree?: string,
  repoPath?: string,
): string | undefined {
  for (const root of [taskWorktree, repoPath]) {
    if (!root) {
      continue;
    }

    const relative = path.relative(path.resolve(root), path.resolve(cwd)).replace(/\\/g, '/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }

    return relative;
  }

  return undefined;
}

function normalizeGateName(value: string): string {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(':');
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function resolveNestedFailureClass(
  fallback: FinalizeFailureClass,
  output: string,
): FinalizeFailureClass {
  if (isNestProviderDrift(output)) {
    return 'test_module_provider_drift';
  }

  return fallback === 'quality_gate_failure' ? 'turbo_nested_quality_gate' : fallback;
}

function parseFailedTests(output: string): string[] {
  const tests: string[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\x1b\[[0-9;]*m/g, '');
    const jestMatch = line.match(/^\s*●\s+(.+)$/);
    if (jestMatch?.[1]) {
      tests.push(jestMatch[1].trim());
      continue;
    }

    const vitestMatch = line.match(/^\s*FAIL\s+(.+?)\s+>\s+(.+)$/);
    if (vitestMatch?.[1] && vitestMatch?.[2]) {
      tests.push(`${vitestMatch[1].trim()} > ${vitestMatch[2].trim()}`);
    }
  }

  return uniqueStrings(tests).slice(0, 100);
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

  if (isNestProviderDrift(output)) {
    return 'test_module_provider_drift';
  }

  if (/(?:cannot find module|did not initialize).*prisma|prisma.*(?:cannot find module|did not initialize)/i.test(output)) {
    return 'generated_artifact_missing';
  }

  if (/golden regression|fixture|jsonl/i.test(output)) {
    return 'deterministic_fixture_drift';
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

function isNestProviderDrift(output: string): boolean {
  return /Nest can't resolve dependencies/i.test(output)
    || /argument .* at index \[\d+\] is available/i.test(output);
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

function uniqueDiagnostics(diagnostics: FinalizeFailureDiagnostic[]): FinalizeFailureDiagnostic[] {
  const seen = new Set<string>();
  const unique: FinalizeFailureDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.file ?? '',
      diagnostic.line ?? '',
      diagnostic.column ?? '',
      diagnostic.severity,
      diagnostic.code ?? '',
      diagnostic.message,
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
