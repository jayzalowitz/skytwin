import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// Defense-in-depth source contract for the worker entrypoint, discovered job
// modules, and their current direct log/persistence sinks. It intentionally
// covers representative aliases and opaque shapes, but is not a semantic proof
// of every JavaScript-equivalent way to invoke a function. Runtime marker tests
// remain required at provider and persistence boundaries.

interface ParsedSource {
  name: string;
  source: ts.SourceFile;
  text: string;
}

function parse(name: string, url: URL): ParsedSource {
  const text = readFileSync(url, 'utf8');
  return {
    name,
    text,
    source: ts.createSourceFile(fileURLToPath(url), text, ts.ScriptTarget.Latest, true),
  };
}

const jobsUrl = new URL('../jobs/', import.meta.url);
const jobSources = readdirSync(fileURLToPath(jobsUrl), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => parse(entry.name.replace(/\.ts$/, ''), new URL(entry.name, jobsUrl)))
  .sort((a, b) => a.name.localeCompare(b.name));
const indexSource = parse('index', new URL('../index.ts', import.meta.url));
const deadLetterSource = parse('dead-letter', new URL('../dead-letter.ts', import.meta.url));
const runtimeSources = [...jobSources, indexSource];
const failureSources = [...runtimeSources, deadLetterSource];

function visit(node: ts.Node, cb: (node: ts.Node) => void): void {
  cb(node);
  ts.forEachChild(node, (child) => visit(child, cb));
}

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.EqualsToken && kind <= ts.SyntaxKind.CaretEqualsToken;
}

function isBindingWrite(node: ts.Node, symbol: string): boolean {
  if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind)) {
    return containsIdentifier(node.left, symbol);
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    containsIdentifier(node.initializer, symbol)) {
    return true;
  }
  return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    containsIdentifier(node.operand, symbol);
}

function containsIdentifier(node: ts.Node, symbol: string): boolean {
  let found = false;
  visit(node, (child) => {
    if (ts.isIdentifier(child) && child.text === symbol) found = true;
  });
  return found;
}

function location(parsed: ParsedSource, node: ts.Node): string {
  const { line, character } = parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source));
  return `${parsed.name}:${line + 1}:${character + 1}`;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function isAllowedFailureReference(parsed: ParsedSource, node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    if (ts.isIdentifier(parent.expression) && parent.expression.text === 'classifyWorkerFailure') {
      return true;
    }
    if (ts.isIdentifier(parent.expression) && parent.expression.text === 'classifyDeadLetterError') {
      return parsed.name === 'dead-letter';
    }
    if (ts.isIdentifier(parent.expression) && (
      parent.expression.text === 'logDeadLetterJobFailure' ||
      parent.expression.text === 'logDeadLetterPurgeFailure'
    )) return parsed.name === 'index';
    if (ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === 'recordOutcome' &&
      ts.isIdentifier(parent.expression.expression) &&
      parent.expression.expression.text === 'deadLetterTracker') return parsed.name === 'index';
  }

  if (ts.isBinaryExpression(parent) && parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(parent.right)) {
    return (parsed.name === 'index' && parent.right.text === 'OAuthRefreshError') ||
      (parsed.name === 'memory-action-loop' && parent.right.text === 'NoAdapterError') ||
      (parsed.name === 'relationship-tier-scheduler' &&
        parent.right.text === 'RelationshipTierTimeoutError');
  }

  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    if (parent.name.text === 'permanent' || parent.name.text === 'statusCode') {
      return parsed.name === 'index';
    }
    if (parent.name.text === 'message') {
      const grandparent = parent.parent;
      return parsed.name === 'index' && ts.isCallExpression(grandparent) &&
        grandparent.arguments.includes(parent) &&
        ts.isIdentifier(grandparent.expression) && grandparent.expression.text === 'extractErrorCode';
    }
  }
  return false;
}

function boundaryViolations(
  parsed: ParsedSource,
  parameter: ts.Identifier,
  body: ts.Node,
): string[] {
  const violations: string[] = [];
  visit(body, (node) => {
    if (!ts.isIdentifier(node) || node.text !== parameter.text) return;
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
    if (!isAllowedFailureReference(parsed, node)) {
      violations.push(location(parsed, node));
    }
  });
  return violations;
}

function trustedModulePath(parsed: ParsedSource, moduleName: string): string {
  return jobSources.some(({ name }) => name === parsed.name)
    ? `../${moduleName}.js`
    : `./${moduleName}.js`;
}

function hasExactImport(parsed: ParsedSource, symbol: string, moduleName: string): boolean {
  const expectedPath = trustedModulePath(parsed, moduleName);
  let found = false;
  visit(parsed.source, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== expectedPath) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    found ||= bindings.elements.some((element) => element.name.text === symbol &&
      (element.propertyName?.text ?? element.name.text) === symbol);
  });
  return found;
}

function bindingIsUnshadowed(parsed: ParsedSource, symbol: string): boolean {
  let declarations = 0;
  let reassigned = false;
  visit(parsed.source, (node) => {
    if (ts.isImportSpecifier(node) && node.name.text === symbol &&
      (node.propertyName?.text ?? node.name.text) === symbol) {
      declarations++;
      return;
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name) {
      declarations += bindingIdentifiers(node.name).filter(({ text }) => text === symbol).length;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === symbol) {
      declarations += 1;
    }
    if (isBindingWrite(node, symbol)) reassigned = true;
  });
  return declarations === 1 && !reassigned;
}

function hasTrustedImport(parsed: ParsedSource, symbol: string, suffix: string): boolean {
  return hasExactImport(parsed, symbol, suffix) && bindingIsUnshadowed(parsed, symbol);
}

function sanitizerImportViolations(parsed: ParsedSource): string[] {
  let usesWorkerClassifier = false;
  let usesOAuthClassifier = false;
  visit(parsed.source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (node.expression.text === 'classifyWorkerFailure') usesWorkerClassifier = true;
    if (node.expression.text === 'extractErrorCode') usesOAuthClassifier = true;
  });
  const violations: string[] = [];
  if (usesWorkerClassifier && !hasTrustedImport(parsed, 'classifyWorkerFailure', 'content-free-error')) {
    violations.push(`${parsed.name}:invalid-classifier-import`);
  }
  if (usesOAuthClassifier && !hasTrustedImport(parsed, 'extractErrorCode', 'oauth-error-code')) {
    violations.push(`${parsed.name}:invalid-oauth-classifier-import`);
  }
  return violations;
}

function catchBoundaryViolations(parsed: ParsedSource): string[] {
  const violations: string[] = [];
  visit(parsed.source, (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const binding of bindingIdentifiers(node.variableDeclaration.name)) {
        violations.push(...boundaryViolations(parsed, binding, node.block));
      }
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'catch') return;
    const callback = node.arguments[0];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    for (const parameter of callback.parameters) {
      for (const binding of bindingIdentifiers(parameter.name)) {
        violations.push(...boundaryViolations(parsed, binding, callback.body));
      }
    }
  });
  return violations;
}

function runtimeCallbackViolations(parsed: ParsedSource): string[] {
  const violations: string[] = [];
  visit(parsed.source, (node) => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) &&
      !ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return;
    if (!node.body) return;
    for (const parameter of node.parameters) {
      for (const binding of bindingIdentifiers(parameter.name)) {
        if (/^(?:err|error|.*Err)$/i.test(binding.text)) {
          violations.push(...boundaryViolations(parsed, binding, node.body));
        }
      }
    }
  });
  return violations;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!('name' in node) || node.name === undefined) return undefined;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)
    ? node.name.text
    : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function staticStringValue(
  parsed: ParsedSource,
  expression: ts.Expression,
  seen = new Set<string>(),
): string | undefined {
  expression = unwrapExpression(expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(parsed, expression.left, new Set(seen));
    const right = staticStringValue(parsed, expression.right, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return undefined;
  seen.add(expression.text);
  const declarations: ts.VariableDeclaration[] = [];
  let written = false;
  visit(parsed.source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === expression.text) declarations.push(node);
    if (isBindingWrite(node, expression.text)) written = true;
  });
  if (written || declarations.length !== 1 || !declarations[0]?.initializer) return undefined;
  return staticStringValue(parsed, declarations[0].initializer, seen);
}

function expressionMemberName(parsed: ParsedSource, expression: ts.Expression): string | undefined {
  expression = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return staticStringValue(parsed, expression.argumentExpression);
  }
  return undefined;
}

const LOG_METHODS = new Set(['debug', 'info', 'log', 'warn', 'error', 'fatal']);

function loggingBindings(parsed: ParsedSource): {
  receivers: Set<string>;
  functions: Map<string, string>;
} {
  const receivers = new Set(['log', 'console']);
  const functions = new Map<string, string>();

  function receiverReference(expression: ts.Expression): boolean {
    expression = unwrapExpression(expression);
    return (ts.isIdentifier(expression) && receivers.has(expression.text)) ||
      (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'createLogger');
  }

  function loggingMethodReference(expression: ts.Expression): string | undefined {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) return functions.get(expression.text);
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      receiverReference(expression.expression)) {
      const method = expressionMemberName(parsed, expression);
      return method && LOG_METHODS.has(method) ? method : undefined;
    }
    if (ts.isCallExpression(expression) &&
      (ts.isPropertyAccessExpression(expression.expression) ||
        ts.isElementAccessExpression(expression.expression)) &&
      expressionMemberName(parsed, expression.expression) === 'bind') {
      return loggingMethodReference(expression.expression.expression);
    }
    return undefined;
  }

  function bindAlias(name: ts.Identifier, initializer: ts.Expression): void {
    if (receiverReference(initializer)) receivers.add(name.text);
    const method = loggingMethodReference(initializer);
    if (method) functions.set(name.text, method);
  }

  function bindDestructuring(
    pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
    initializer: ts.Expression,
  ): void {
    if (!receiverReference(initializer)) return;
    const elements = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
    for (const element of elements) {
      if (ts.isBindingElement(element)) {
        const member = element.propertyName ?? element.name;
        if ((ts.isIdentifier(member) || ts.isStringLiteral(member)) &&
          LOG_METHODS.has(member.text) && ts.isIdentifier(element.name)) {
          functions.set(element.name.text, member.text);
        }
      } else if (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) {
        const member = propertyName(element);
        const target = ts.isPropertyAssignment(element) ? element.initializer : element.name;
        if (member && LOG_METHODS.has(member) && ts.isIdentifier(target)) {
          functions.set(target.text, member);
        }
      }
    }
  }

  let priorSize = -1;
  while (priorSize !== receivers.size + functions.size) {
    priorSize = receivers.size + functions.size;
    visit(parsed.source, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) bindAlias(node.name, node.initializer);
        if (ts.isObjectBindingPattern(node.name)) bindDestructuring(node.name, node.initializer);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) bindAlias(node.left, node.right);
        if (ts.isObjectLiteralExpression(node.left)) bindDestructuring(node.left, node.right);
      }
    });
  }
  return { receivers, functions };
}

function failureLogViolations(parsed: ParsedSource): string[] {
  const violations: string[] = [];
  const logging = loggingBindings(parsed);
  const forbiddenFields = new Set([
    'error', 'message', 'msg', 'reason', 'reasoning', 'body', 'detail',
    'response', 'content', 'payload', 'displayName', 'skillName',
  ]);

  function methodReference(expression: ts.Expression): string | undefined {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) return logging.functions.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const receiver = expression.expression;
      const method = expressionMemberName(parsed, expression);
      return ts.isIdentifier(receiver) && logging.receivers.has(receiver.text) && method &&
        LOG_METHODS.has(method) ? method : undefined;
    }
    return undefined;
  }

  visit(parsed.source, (node) => {
    if (!ts.isCallExpression(node)) return;
    let args: readonly ts.Expression[] = node.arguments;
    let method = methodReference(node.expression);
    let recognized = method !== undefined;
    if (ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)) {
      const invocation = expressionMemberName(parsed, node.expression);
      const indirectMethod = invocation === 'call' || invocation === 'apply'
        ? methodReference(node.expression.expression)
        : undefined;
      if (indirectMethod && invocation === 'apply') {
        violations.push(location(parsed, node));
        return;
      }
      if (indirectMethod && invocation === 'call') {
        method = indirectMethod;
        args = node.arguments.slice(1);
        recognized = true;
      }
    }
    if (ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' && node.expression.name.text === 'apply' &&
      node.arguments[0] && methodReference(node.arguments[0])) {
      violations.push(location(parsed, node));
      return;
    }
    const receiver = (ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)) &&
      ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : null;
    recognized ||= !!receiver && logging.receivers.has(receiver);
    if (!recognized || (method !== undefined && !LOG_METHODS.has(method))) return;
    if (ts.isElementAccessExpression(node.expression)) {
      violations.push(location(parsed, node.expression));
    }
    const message = args[0];
    if (message && !ts.isStringLiteral(message) && !ts.isNoSubstitutionTemplateLiteral(message)) {
      violations.push(location(parsed, message));
    }
    for (const arg of args) {
      visit(arg, (child) => {
        if (ts.isSpreadElement(child) || ts.isSpreadAssignment(child) ||
          ts.isComputedPropertyName(child) || ts.isElementAccessExpression(child)) {
          violations.push(location(parsed, child));
        }
        if (ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) {
          const name = propertyName(child);
          if (name && forbiddenFields.has(name)) violations.push(location(parsed, child));
          const errorCodeValue = ts.isPropertyAssignment(child)
            ? child.initializer
            : ts.isShorthandPropertyAssignment(child) ? child.name : null;
          if (name === 'errorCode' &&
            (!errorCodeValue || !isSanitizedExpression(parsed, errorCodeValue))) {
              violations.push(location(parsed, child));
            }
        }
      });
    }
  });
  return violations;
}

const STABLE_FAILURE_CODES = new Set([
  'broker_unavailable', 'configuration_invalid', 'database_unavailable',
  'job_failed', 'legacy_redacted', 'network_unavailable', 'rate_limited',
  'timeout', 'vault_locked', 'invalid_grant', 'unauthorized_client',
]);

function isSanitizedExpression(
  parsed: ParsedSource,
  expression: ts.Expression,
  seen = new Set<string>(),
): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return isSanitizedExpression(parsed, expression.expression, seen);
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined')) return true;
  if (ts.isStringLiteral(expression)) return STABLE_FAILURE_CODES.has(expression.text);
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (expression.expression.text === 'classifyWorkerFailure') {
      return hasTrustedImport(parsed, 'classifyWorkerFailure', 'content-free-error');
    }
    if (expression.expression.text === 'classifyDeadLetterError') {
      return parsed.name === 'dead-letter' && bindingIsUnshadowed(parsed, 'classifyDeadLetterError');
    }
    if (expression.expression.text === 'extractErrorCode') {
      return hasTrustedImport(parsed, 'extractErrorCode', 'oauth-error-code');
    }
  }
  if (ts.isConditionalExpression(expression)) {
    return isSanitizedExpression(parsed, expression.whenTrue, seen) &&
      isSanitizedExpression(parsed, expression.whenFalse, seen);
  }
  if (ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isSanitizedExpression(parsed, expression.left, seen) &&
      isSanitizedExpression(parsed, expression.right, seen);
  }
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return false;
  seen.add(expression.text);
  const declarations: ts.VariableDeclaration[] = [];
  let reassigned = false;
  visit(parsed.source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === expression.text) declarations.push(node);
    if (isBindingWrite(node, expression.text)) reassigned = true;
  });
  return !reassigned && declarations.length > 0 && declarations.every((declaration) =>
    !!declaration.initializer &&
    isSanitizedExpression(parsed, declaration.initializer, new Set(seen)));
}

function isDirectWorkerClassifierInput(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) &&
    ts.isIdentifier(parent.expression) && parent.expression.text === 'classifyWorkerFailure';
}

function resultErrorViolations(parsed: ParsedSource): string[] {
  const violations: string[] = [];
  visit(parsed.source, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'error') {
      if (ts.isIdentifier(node.expression) && (node.expression.text === 'log' ||
        node.expression.text === 'console')) return;
      if (!isDirectWorkerClassifierInput(node)) violations.push(location(parsed, node));
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression
        ? staticStringValue(parsed, node.argumentExpression)
        : undefined;
      const looksLikeResult = ts.isIdentifier(node.expression) &&
        /(?:result|outcome|response)$/i.test(node.expression.text);
      if ((key === 'error' || (key === undefined && looksLikeResult)) &&
        !isDirectWorkerClassifierInput(node)) {
        violations.push(location(parsed, node));
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name;
        if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'error') {
          violations.push(location(parsed, element));
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)) {
      for (const element of node.left.properties) {
        const name = propertyName(element);
        if (name === 'error') violations.push(location(parsed, element));
      }
    }
  });
  return violations;
}

type FailureSink = 'markJobFailed' | 'objectFailure';

function persistenceBindings(parsed: ParsedSource): {
  functions: Map<string, FailureSink>;
  connectorHealthReceivers: Set<string>;
} {
  const functions = new Map<string, FailureSink>([['markJobFailed', 'markJobFailed']]);
  const connectorHealthReceivers = new Set(['connectorHealthRepository']);

  function receiverAlias(expression: ts.Expression): boolean {
    expression = unwrapExpression(expression);
    return ts.isIdentifier(expression) && connectorHealthReceivers.has(expression.text);
  }

  function sinkReference(expression: ts.Expression): FailureSink | undefined {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) return functions.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const method = expressionMemberName(parsed, expression);
      if (method === 'markJobFailed') return 'markJobFailed';
      if (method === 'markSyncResult' || method === 'createResult') return 'objectFailure';
      if (method === 'upsert' && receiverAlias(expression.expression)) return 'objectFailure';
    }
    if (ts.isCallExpression(expression) &&
      (ts.isPropertyAccessExpression(expression.expression) ||
        ts.isElementAccessExpression(expression.expression)) &&
      expressionMemberName(parsed, expression.expression) === 'bind') {
      return sinkReference(expression.expression.expression);
    }
    return undefined;
  }

  function bindIdentifier(name: ts.Identifier, initializer: ts.Expression): void {
    if (receiverAlias(initializer)) connectorHealthReceivers.add(name.text);
    const sink = sinkReference(initializer);
    if (sink) functions.set(name.text, sink);
  }

  function bindDestructuring(
    pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
    initializer: ts.Expression,
  ): void {
    const connectorReceiver = receiverAlias(initializer);
    const elements = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
    for (const element of elements) {
      let member: string | undefined;
      let target: ts.Expression | ts.BindingName | undefined;
      if (ts.isBindingElement(element)) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property) || ts.isStringLiteral(property)) member = property.text;
        target = element.name;
      } else if (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) {
        member = propertyName(element);
        target = ts.isPropertyAssignment(element) ? element.initializer : element.name;
      }
      if (!target || !ts.isIdentifier(target)) continue;
      if (member === 'markJobFailed') functions.set(target.text, 'markJobFailed');
      if (member === 'markSyncResult' || member === 'createResult' ||
        (member === 'upsert' && connectorReceiver)) {
        functions.set(target.text, 'objectFailure');
      }
    }
  }

  let priorSize = -1;
  while (priorSize !== functions.size + connectorHealthReceivers.size) {
    priorSize = functions.size + connectorHealthReceivers.size;
    visit(parsed.source, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) bindIdentifier(node.name, node.initializer);
        if (ts.isObjectBindingPattern(node.name)) bindDestructuring(node.name, node.initializer);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) bindIdentifier(node.left, node.right);
        if (ts.isObjectLiteralExpression(node.left)) bindDestructuring(node.left, node.right);
      }
    });
  }
  return { functions, connectorHealthReceivers };
}

function persistenceViolations(parsed: ParsedSource): string[] {
  const violations: string[] = [];
  const bindings = persistenceBindings(parsed);
  visit(parsed.source, (node) => {
    if (!ts.isCallExpression(node)) return;
    let sink: FailureSink | undefined;
    let args: readonly ts.Expression[] = node.arguments;
    if (ts.isIdentifier(node.expression)) sink = bindings.functions.get(node.expression.text);
    if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
      const method = expressionMemberName(parsed, node.expression);
      const receiver = node.expression.expression;
      if (method === 'markJobFailed') sink = 'markJobFailed';
      if (method === 'markSyncResult' || method === 'createResult') sink = 'objectFailure';
      if (method === 'upsert' && ts.isIdentifier(receiver) &&
        bindings.connectorHealthReceivers.has(receiver.text)) sink = 'objectFailure';
      if (method === 'call') {
        const indirectSink = ts.isIdentifier(receiver)
          ? bindings.functions.get(receiver.text)
          : (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
            ? expressionMemberName(parsed, receiver) === 'markJobFailed'
              ? 'markJobFailed'
              : expressionMemberName(parsed, receiver) === 'markSyncResult' ||
                  expressionMemberName(parsed, receiver) === 'createResult'
                ? 'objectFailure'
                : undefined
            : undefined;
        sink = indirectSink;
        args = node.arguments.slice(1);
      }
      if (method === 'apply' && ((ts.isIdentifier(receiver) &&
        bindings.functions.has(receiver.text)) ||
        ((ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) &&
          ['markJobFailed', 'markSyncResult', 'createResult'].includes(
            expressionMemberName(parsed, receiver) ?? '',
          )))) {
        violations.push(location(parsed, node));
        return;
      }
    }
    if (!sink) return;
    if (sink === 'markJobFailed') {
      const value = args[1];
      if (!value || !isSanitizedExpression(parsed, value)) {
        violations.push(location(parsed, node));
      }
      return;
    }
    const input = args[0];
    if (!input || !ts.isObjectLiteralExpression(input)) {
      violations.push(location(parsed, node));
      return;
    }
    if (input.properties.some((property) => ts.isSpreadAssignment(property) ||
      ('name' in property && property.name !== undefined && ts.isComputedPropertyName(property.name)))) {
      violations.push(location(parsed, input));
    }
    for (const property of input.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property);
      if (name === 'error') {
        if (!isSanitizedExpression(parsed, property.initializer)) {
          violations.push(location(parsed, property));
        }
      }
      if (name === 'errorCode' && !isSanitizedExpression(parsed, property.initializer)) {
        violations.push(location(parsed, property));
      }
    }
  });
  return violations;
}

function syntheticSource(text: string): ParsedSource {
  return {
    name: 'synthetic',
    text,
    source: ts.createSourceFile('synthetic.ts', text, ts.ScriptTarget.Latest, true),
  };
}

describe('audited scheduled worker failure surfaces remain content-free', () => {
  it('discovers every job module and the modules scheduled by the worker entrypoint', () => {
    expect(jobSources.length).toBeGreaterThan(0);
    const discovered = new Set(jobSources.map(({ name }) => name));
    const scheduled = new Set<string>();
    visit(indexSource.source, (node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const match = node.moduleSpecifier.text.match(/^\.\/jobs\/([^/]+)\.js$/);
      if (match?.[1]) scheduled.add(match[1]);
    });
    expect(scheduled.size).toBeGreaterThan(0);
    expect([...scheduled].filter((name) => !discovered.has(name))).toEqual([]);
  });

  it('sanitizes ordinary, destructured, Promise, callback, maintenance, and fatal boundaries', () => {
    const violations = failureSources.flatMap(catchBoundaryViolations);
    violations.push(...runtimeSources.flatMap(runtimeCallbackViolations));
    violations.push(...failureSources.flatMap(sanitizerImportViolations));
    expect(violations, 'throwables may only enter an audited content-free boundary').toEqual([]);
  });

  it('uses literal, non-spread content-free failure log payloads', () => {
    expect(failureSources.flatMap(failureLogViolations),
      'failure logs cannot use raw-shaped fields, computed keys, element access, or spreads').toEqual([]);
  });

  it('classifies result errors directly and persists only bounded codes', () => {
    expect(runtimeSources.flatMap(resultErrorViolations),
      'result.error cannot pass through an alias or wrapper').toEqual([]);
    expect(runtimeSources.flatMap(persistenceViolations),
      'known worker failure columns accept only classified code variables').toEqual([]);
  });

  it('never reads a federation peer failure response body', () => {
    const federation = jobSources.find(({ name }) => name === 'federation-sync');
    expect(federation).toBeDefined();
    expect(federation!.text).not.toMatch(/\bres\.text\s*\(/);
  });

  it('rejects alias, wrapper, computed, spread, destructured, and result-error bypasses', () => {
    const caughtBypasses = syntheticSource(`
      try { work(); } catch ({ message }) { log.error('x', { error: message }); }
      promise.catch((err) => { const alias = err; classifyWorkerFailure(alias); });
      try { work(); } catch (error) { wrapper(error); }
      try { work(); } catch (error) { log.warn('x', { ...error }); }
      try { work(); } catch (error) { log.warn('x', error['message']); }
    `);
    expect(catchBoundaryViolations(caughtBypasses).length).toBeGreaterThanOrEqual(5);
    expect(failureLogViolations(caughtBypasses).length).toBeGreaterThanOrEqual(3);

    const resultBypasses = syntheticSource(`
      log.warn('x', { ...result });
      const alias = result.error;
      wrapper(other['error']);
      const { error } = third;
      const key = 'error';
      wrapper(fourth[key]);
      const prefix = 'err';
      wrapper(fifth[prefix + 'or']);
      let assigned;
      ({ error: assigned } = sixth);
    `);
    expect(resultErrorViolations(resultBypasses).length).toBe(6);
    expect(failureLogViolations(resultBypasses).length).toBeGreaterThan(0);
  });

  it('rejects classifier shadowing and tainted failure-code aliases', () => {
    const wrongImport = syntheticSource(`
      import { classifyWorkerFailure } from '../lookalike/content-free-error.js';
      try { work(); } catch (error) {
        log.warn('Scheduled work failed', { errorCode: classifyWorkerFailure(error) });
      }
    `);
    expect(sanitizerImportViolations(wrongImport)).toContain(
      'synthetic:invalid-classifier-import',
    );

    const shadowedClassifier = syntheticSource(`
      import { classifyWorkerFailure } from './content-free-error.js';
      function run(classifyWorkerFailure: (value: unknown) => string) {
        try { work(); } catch (error) {
          log.warn('Scheduled work failed', { errorCode: classifyWorkerFailure(error) });
        }
      }
    `);
    expect(sanitizerImportViolations(shadowedClassifier)).toContain(
      'synthetic:invalid-classifier-import',
    );
    expect(failureLogViolations(shadowedClassifier).length).toBeGreaterThan(0);

    const destructuredShadow = syntheticSource(`
      import { classifyWorkerFailure } from './content-free-error.js';
      function run({ classifyWorkerFailure }: { classifyWorkerFailure: (value: unknown) => string }) {
        try { work(); } catch (error) {
          log.warn('Scheduled work failed', { errorCode: classifyWorkerFailure(error) });
        }
      }
    `);
    expect(sanitizerImportViolations(destructuredShadow)).toContain(
      'synthetic:invalid-classifier-import',
    );

    const taintedCode = syntheticSource(`
      try { work(); } catch (error) {
        const errorCode = error.message;
        log.info('Scheduled work failed', { errorCode });
      }
    `);
    expect(failureLogViolations(taintedCode).length).toBeGreaterThan(0);

    const reassignedCode = syntheticSource(`
      import { classifyWorkerFailure } from './content-free-error.js';
      try { work(); } catch (error) {
        let errorCode = classifyWorkerFailure(error);
        ({ errorCode } = untrusted);
        log.info('Scheduled work failed', { errorCode });
      }
    `);
    expect(failureLogViolations(reassignedCode).length).toBeGreaterThan(0);

    for (const mutation of [
      `for (errorCode of providerCodes) {}`,
      `for (errorCode in providerCodes) {}`,
      `errorCode++;`,
      `errorCode += rawProviderCode;`,
    ]) {
      const iteratedCode = syntheticSource(`
        import { classifyWorkerFailure } from './content-free-error.js';
        try { work(); } catch (error) {
          let errorCode = classifyWorkerFailure(error);
          ${mutation}
          log.info('Scheduled work failed', { errorCode });
        }
      `);
      expect(failureLogViolations(iteratedCode).length, mutation).toBeGreaterThan(0);
    }
  });

  it('rejects indirect persistence and dynamic or structurally opaque logging', () => {
    const indirectPersistence = syntheticSource(`
      const failure = { jobId: 'id', error: rawReason };
      repository.markSyncResult(failure);
      const oauthState = { status: 'needs_reauth', errorCode: rawReason };
      connectorHealthRepository.upsert(oauthState);
    `);
    expect(persistenceViolations(indirectPersistence).length).toBe(2);

    for (const mutation of [
      `const save = repository.markSyncResult.bind(repository); save(failure);`,
      `const first = repository.createResult; const save = first; save(failure);`,
      `let save; save = repository.markSyncResult; save(failure);`,
      `const { markSyncResult: save } = repository; save(failure);`,
      `let save; ({ createResult: save } = repository); save(failure);`,
      `const save = connectorHealthRepository.upsert.bind(connectorHealthRepository); save(failure);`,
      `const save = repository.markSyncResult; save.call(repository, failure);`,
      `repository.createResult.call(repository, failure);`,
      `const save = repository.markSyncResult; save.apply(repository, [failure]);`,
    ]) {
      const aliasedPersistence = syntheticSource(`
        const failure = { error: rawReason };
        ${mutation}
      `);
      expect(persistenceViolations(aliasedPersistence).length, mutation).toBeGreaterThan(0);
    }

    const opaqueLogs = syntheticSource(`
      log.info('Failed: ' + rawReason);
      log.warn(dynamicMessage, { safe: true });
      log.error('Failed', { [dynamicKey]: rawReason });
      log.fatal('Failed', { ...rawObject });
      console.info('Failed', rawObject['message']);
      const logger = log;
      logger.info(dynamicMessage);
      const info = log.info;
      info(dynamicMessage);
      const { warn } = log;
      warn(dynamicMessage);
      const bound = log.error.bind(log);
      bound(dynamicMessage);
      const first = log.info;
      const chained = first;
      chained(dynamicMessage);
      let assigned;
      assigned = log.warn;
      assigned(dynamicMessage);
      let destructured;
      ({ fatal: destructured } = log);
      destructured(dynamicMessage);
      const callable = log.info;
      callable.call(log, dynamicMessage);
      callable.apply(log, [dynamicMessage]);
      Reflect.apply(log.error, log, [dynamicMessage]);
      log[dynamicMethod](dynamicMessage);
    `);
    expect(failureLogViolations(opaqueLogs).length).toBeGreaterThanOrEqual(16);
  });
});
