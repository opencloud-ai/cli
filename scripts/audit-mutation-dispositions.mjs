import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "dist", "index.cjs");
const [sourceText, accountAuthText, workspaceAuthText, contractText, dispositionText] = await Promise.all([
  readFile(path.join(root, "src", "index.ts"), "utf8"),
  readFile(path.join(root, "src", "account-auth.ts"), "utf8"),
  readFile(path.join(root, "src", "workspace-auth.ts"), "utf8"),
  readFile(path.join(root, "vendor", "contracts", "src", "control-plane.ts"), "utf8"),
  readFile(path.join(root, "src", "mutation-dispositions.ts"), "utf8"),
]);
const source = ts.createSourceFile(
  "src/index.ts",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const contract = ts.createSourceFile(
  "vendor/contracts/src/control-plane.ts",
  contractText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const dispositions = ts.createSourceFile(
  "src/mutation-dispositions.ts",
  dispositionText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const auditedSources = new Map([
  ["src/index.ts", source],
  [
    "src/account-auth.ts",
    ts.createSourceFile(
      "src/account-auth.ts",
      accountAuthText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  ],
  [
    "src/workspace-auth.ts",
    ts.createSourceFile(
      "src/workspace-auth.ts",
      workspaceAuthText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  ],
]);

function unwrap(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function objectProperty(object, name) {
  const value = unwrap(object);
  if (!ts.isObjectLiteralExpression(value)) return null;
  return (
    value.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) && propertyName(property.name) === name,
    ) ?? null
  );
}

function literalValue(node) {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  return undefined;
}

function declaredObject(file, name) {
  let result = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const value = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(value)) result = value;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(result, `Could not find ${name}`);
  return result;
}

const registryObject = declaredObject(dispositions, "mutationDispositionRegistry");
const registry = new Map();
for (const property of registryObject.properties) {
  if (!ts.isPropertyAssignment(property)) continue;
  const command = propertyName(property.name);
  const value = unwrap(property.initializer);
  const boundary = objectProperty(value, "boundary");
  assert.ok(command && boundary, "Invalid mutation disposition entry");
  registry.set(command, literalValue(boundary.initializer));
}

const nonJournalObject = declaredObject(
  dispositions,
  "nonJournalMutationInventory",
);
const nonJournal = new Map();
for (const property of nonJournalObject.properties) {
  if (!ts.isPropertyAssignment(property)) continue;
  const id = propertyName(property.name);
  const value = unwrap(property.initializer);
  const sourceFile = objectProperty(value, "sourceFile");
  const sourceFunction = objectProperty(value, "sourceFunction");
  const operation = objectProperty(value, "operation");
  const commanderLeaves = objectProperty(value, "commanderLeaves");
  const recovery = objectProperty(value, "recovery");
  assert.ok(
    id && sourceFile && operation && commanderLeaves && recovery,
    "Invalid non-journal mutation inventory entry",
  );
  nonJournal.set(id, {
    sourceFile: literalValue(sourceFile.initializer),
    sourceFunction: sourceFunction
      ? literalValue(sourceFunction.initializer)
      : undefined,
    operation: literalValue(operation.initializer),
    commanderLeaves: evaluate(commanderLeaves.initializer, new Map()),
    recovery: literalValue(recovery.initializer),
  });
}

function evaluate(node, environment) {
  const value = unwrap(node);
  const literal = literalValue(value);
  if (literal !== undefined) return literal;
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((item) => evaluate(item, environment));
  }
  if (ts.isIdentifier(value)) return environment.get(value.text);
  if (ts.isElementAccessExpression(value)) {
    const target = evaluate(value.expression, environment);
    const index = value.argumentExpression
      ? evaluate(value.argumentExpression, environment)
      : undefined;
    return Array.isArray(target) && typeof index === "number"
      ? target[index]
      : undefined;
  }
  if (ts.isTemplateExpression(value)) {
    let output = value.head.text;
    for (const span of value.templateSpans) {
      const resolved = evaluate(span.expression, environment);
      if (typeof resolved !== "string" && typeof resolved !== "number") {
        return undefined;
      }
      output += String(resolved) + span.literal.text;
    }
    return output;
  }
  return undefined;
}

function visitExpanded(node, environment, visitor) {
  if (ts.isForOfStatement(node)) {
    const declaration = node.initializer.declarations?.[0];
    const values = evaluate(node.expression, environment);
    if (
      declaration &&
      ts.isIdentifier(declaration.name) &&
      Array.isArray(values)
    ) {
      for (const value of values) {
        const nested = new Map(environment);
        nested.set(declaration.name.text, value);
        visitExpanded(node.statement, nested, visitor);
      }
      return;
    }
  }
  visitor(node, environment);
  ts.forEachChild(node, (child) => visitExpanded(child, environment, visitor));
}

const exactRegistry = [...registry]
  .filter(([, boundary]) => boundary === "exact_app")
  .map(([command]) => command)
  .sort();

function commandPathForExpression(node, environment, groups) {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return groups.get(value.text) ?? null;
  if (!ts.isCallExpression(value)) return null;
  if (ts.isIdentifier(value.expression)) {
    if (value.expression.text === "addOperationOptions" && value.arguments[0]) {
      return commandPathForExpression(value.arguments[0], environment, groups);
    }
    return null;
  }
  if (!ts.isPropertyAccessExpression(value.expression)) return null;
  const base = commandPathForExpression(
    value.expression.expression,
    environment,
    groups,
  );
  if (!base) return null;
  if (value.expression.name.text !== "command") return base;
  const command = value.arguments[0]
    ? evaluate(value.arguments[0], environment)
    : undefined;
  if (typeof command !== "string") return null;
  return [...base, command.trim().split(/\s+/, 1)[0]];
}

function commandGroups(file) {
  const groups = new Map([["program", ["opencloud"]]]);
  const declarations = [];
  ts.forEachChild(file, function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  });
  for (let pass = 0; pass < declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (groups.has(declaration.name.text)) continue;
      const resolved = commandPathForExpression(
        declaration.initializer,
        new Map(),
        groups,
      );
      if (resolved) {
        groups.set(declaration.name.text, resolved);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return groups;
}

function commandIdsInAction(callback, environment, file) {
  const ids = new Set();
  const feedsJournal = (property) => {
    let current = property.parent;
    let intentCall = null;
    while (current && current !== callback) {
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
        if (
          ["outputReplayMutation", "outputDurableMutation"].includes(
            current.expression.text,
          ) &&
          current.arguments[0] &&
          property.pos >= current.arguments[0].pos &&
          property.end <= current.arguments[0].end
        ) {
          return true;
        }
        if (current.expression.text === "mutationIntent") intentCall = current;
      }
      if (
        intentCall &&
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "run" &&
        current.expression.expression.getText(file).endsWith(".journal") &&
        current.arguments[0] &&
        intentCall.pos >= current.arguments[0].pos &&
        intentCall.end <= current.arguments[0].end
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "commandId" &&
      feedsJournal(node)
    ) {
      const command = evaluate(node.initializer, environment);
      if (typeof command === "string" && command.startsWith("opencloud ")) {
        ids.add(command);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return ids;
}

function commanderActionWiring(file) {
  const groups = commandGroups(file);
  const wiring = new Map();
  visitExpanded(file, new Map(), (node, environment) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "action" ||
      !node.arguments[0]
    ) {
      return;
    }
    const pathParts = commandPathForExpression(
      node.expression.expression,
      environment,
      groups,
    );
    if (!pathParts) return;
    const command = pathParts.join(" ");
    const ids = commandIdsInAction(node.arguments[0], environment, file);
    const existing = wiring.get(command) ?? new Set();
    for (const id of ids) existing.add(id);
    wiring.set(command, existing);
  });
  return wiring;
}

const actionWiring = commanderActionWiring(source);
const wired = new Set();
for (const [leaf, ids] of actionWiring) {
  for (const command of ids) {
    assert.equal(
      command,
      leaf,
      `Commander leaf ${leaf} is wired to a different mutation disposition: ${command}`,
    );
    wired.add(command);
  }
}
assert.deepEqual(
  [...wired].sort(),
  exactRegistry,
  "Exact-app registry and executable Commander action wiring differ",
);

function commandHelp(parts) {
  const result = spawnSync(binary, [...parts, "--help"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function children(help) {
  const marker = "\nCommands:\n";
  const offset = help.indexOf(marker);
  if (offset < 0) return [];
  return [
    ...new Set(
      help
        .slice(offset + marker.length)
        .split("\n")
        .flatMap((line) => {
          const match = /^  ([a-z][a-z0-9-]*)(?:\s|$)/.exec(line);
          return match?.[1] && match[1] !== "help" ? [match[1]] : [];
        }),
    ),
  ];
}

const leaves = new Set();
const walkCommands = (parts) => {
  const names = children(commandHelp(parts));
  if (parts.length && names.length === 0) {
    leaves.add(["opencloud", ...parts].join(" "));
    return;
  }
  for (const name of names) walkCommands([...parts, name]);
};
walkCommands([]);
for (const command of registry.keys()) {
  assert.ok(leaves.has(command), `Registry key has no Commander leaf: ${command}`);
}
for (const [id, record] of nonJournal) {
  assert.ok(
    Array.isArray(record.commanderLeaves) && record.commanderLeaves.length > 0,
    `Non-journal inventory entry has no Commander leaves: ${id}`,
  );
  for (const command of record.commanderLeaves) {
    assert.ok(
      leaves.has(command),
      `Non-journal inventory ${id} references no Commander leaf: ${command}`,
    );
  }
}

const operationsObject = declaredObject(contract, "controlPlaneOperations");
const operations = new Map();
for (const property of operationsObject.properties) {
  if (!ts.isPropertyAssignment(property)) continue;
  const name = propertyName(property.name);
  const call = unwrap(property.initializer);
  if (!name || !ts.isCallExpression(call) || call.arguments.length !== 1) continue;
  const definition = unwrap(call.arguments[0]);
  const method = objectProperty(definition, "method");
  const route = objectProperty(definition, "path");
  const mcp = objectProperty(definition, "mcp");
  const readOnly = mcp
    ? objectProperty(unwrap(mcp.initializer), "readOnlyHint")
    : null;
  operations.set(name, {
    method: method ? literalValue(method.initializer) : undefined,
    path: route ? literalValue(route.initializer) : undefined,
    readOnly: readOnly ? literalValue(readOnly.initializer) : false,
  });
}

function normalizedRoute(node) {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  if (!ts.isTemplateExpression(value)) return null;
  return (
    value.head.text +
    value.templateSpans
      .map((span) => `{}` + span.literal.text)
      .join("")
  );
}

function normalizedContractRoute(value) {
  return typeof value === "string" ? value.replace(/\{[^}]+\}/g, "{}") : null;
}

function containingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function logicalMutationOperation(node, sourceFile) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression) && node.expression.text === "postForm") {
    return sourceFile === "src/account-auth.ts"
      ? {
          operation: "postForm",
          sourceFunction: containingFunctionName(node),
        }
      : null;
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  if (method === "call" && node.arguments[0]) {
    const operationName = literalValue(node.arguments[0]);
    const operation = operations.get(operationName);
    if (
      typeof operationName === "string" &&
      operation &&
      operation.method !== "GET" &&
      operation.readOnly !== true
    ) {
      return {
        operation: `control:${operationName}`,
        sourceFunction: containingFunctionName(node),
        contractPath: operation.path,
      };
    }
    return null;
  }
  if (!["post", "patch", "put", "delete"].includes(method) || !node.arguments[0]) {
    return null;
  }
  const route = normalizedRoute(node.arguments[0]);
  if (!route) return null;
  const matching = [...operations.values()].find(
    (operation) =>
      operation.method === method.toUpperCase() &&
      normalizedContractRoute(operation.path) === route,
  );
  if (matching?.readOnly === true) return null;
  return {
    operation: `${method.toUpperCase()} ${route}`,
    sourceFunction: containingFunctionName(node),
    contractPath: matching?.path,
  };
}

function inventoryCoordinate(sourceFile, sourceFunction, operation) {
  return `${sourceFile}\0${sourceFunction ?? ""}\0${operation}`;
}

const declaredNonJournalCoordinates = new Set();
for (const [id, record] of nonJournal) {
  assert.equal(typeof record.sourceFile, "string", `${id} sourceFile`);
  assert.equal(typeof record.operation, "string", `${id} operation`);
  assert.equal(typeof record.recovery, "string", `${id} recovery`);
  const coordinate = inventoryCoordinate(
    record.sourceFile,
    record.sourceFunction,
    record.operation,
  );
  assert.ok(
    !declaredNonJournalCoordinates.has(coordinate),
    `Duplicate non-journal mutation callsite: ${id}`,
  );
  declaredNonJournalCoordinates.add(coordinate);
}

const discoveredNonJournalCoordinates = new Set();
for (const [sourceFile, sourceFileAst] of auditedSources) {
  const visit = (node) => {
    const logical = logicalMutationOperation(node, sourceFile);
    if (logical) {
      const isAccountPost =
        sourceFile === "src/account-auth.ts" && logical.operation === "postForm";
      const isNonAppRoute =
        logical.operation.includes(" ") &&
        !logical.operation.slice(logical.operation.indexOf(" ") + 1).startsWith(
          "/v1/apps/{}",
        );
      const isNonAppContract =
        logical.operation.startsWith("control:") &&
        (!logical.contractPath?.includes("{appId}") ||
          sourceFile !== "src/index.ts");
      if (isAccountPost || isNonAppRoute || isNonAppContract) {
        discoveredNonJournalCoordinates.add(
          inventoryCoordinate(
            sourceFile,
            logical.operation.includes(" ") ||
              logical.operation === "control:createApp"
              ? undefined
              : logical.sourceFunction,
            logical.operation,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFileAst);
}
assert.deepEqual(
  [...declaredNonJournalCoordinates].sort(),
  [...discoveredNonJournalCoordinates].sort(),
  "Declared non-journal mutation inventory and audited authority/bootstrap callsites differ",
);
assert.deepEqual(
  nonJournal.get("account.revoke")?.commanderLeaves,
  ["opencloud login", "opencloud auth logout", "opencloud logout"],
  "Account revocation inventory must cover login --force and both logout leaves",
);

function isExactAppMutationCall(node, environment, file) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const method = node.expression.name.text;
  if (method === "call" && node.arguments[0]) {
    const operationName = evaluate(node.arguments[0], environment);
    const operation = operations.get(operationName);
    if (operation) {
      return Boolean(
        operation.path?.includes("{appId}") &&
          operation.method !== "GET" &&
          operation.readOnly !== true,
      );
    }
    return /(?:^|\.)(?:control|client)(?:\(\))?$/.test(
      node.expression.expression.getText(file),
    );
  }
  if (["uploadFile", "uploadDeployment"].includes(method)) return true;
  if (!["post", "patch", "put", "delete"].includes(method) || !node.arguments[0]) {
    return false;
  }
  const route = normalizedRoute(node.arguments[0]);
  if (route) {
    const matching = [...operations.values()].find(
      (operation) =>
        operation.method === method.toUpperCase() &&
        normalizedContractRoute(operation.path) === route,
    );
    if (matching?.readOnly === true) return false;
    return route.startsWith("/v1/apps/{}");
  }
  // A dynamic raw route cannot be proven read-only. Treat HTTP-client-shaped
  // receivers as mutations so aliases such as control.delete(target) cannot
  // evade the release audit.
  return /(?:^|\.)(?:control|client)(?:\(\))?$/.test(
    node.expression.expression.getText(file),
  );
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

function containingNamedFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      const name = functionName(current);
      if (name) return name;
    }
    current = current.parent;
  }
  return null;
}

function callbackContains(call, node) {
  return call.arguments.some(
    (argument) =>
      isFunctionLike(unwrap(argument)) &&
      node.pos >= argument.pos &&
      node.end <= argument.end,
  );
}

function isJournalBoundary(call, file) {
  if (ts.isIdentifier(call.expression)) {
    return ["outputReplayMutation", "outputDurableMutation"].includes(
      call.expression.text,
    );
  }
  return Boolean(
    ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "run" &&
      call.expression.expression.getText(file).endsWith(".journal"),
  );
}

function isLexicallyJournalProtected(node, file) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      isJournalBoundary(current, file) &&
      callbackContains(current, node)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function localCallsites(file) {
  const calls = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const existing = calls.get(node.expression.text) ?? [];
      existing.push(node);
      calls.set(node.expression.text, existing);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function auditExactAppMutations(file) {
  const callsites = localCallsites(file);
  const callerChainProtected = (name, visiting = new Set()) => {
    if (visiting.has(name)) return true;
    const callers = callsites.get(name) ?? [];
    if (callers.length === 0) return false;
    const nested = new Set(visiting).add(name);
    return callers.every((call) => {
      if (isLexicallyJournalProtected(call, file)) return true;
      const owner = containingNamedFunction(call);
      return owner ? callerChainProtected(owner, nested) : false;
    });
  };
  const violations = [];
  visitExpanded(file, new Map(), (node, environment) => {
    if (!isExactAppMutationCall(node, environment, file)) return;
    const protectedHere = isLexicallyJournalProtected(node, file);
    const owner = containingNamedFunction(node);
    if (!protectedHere && !(owner && callerChainProtected(owner))) {
      const position = file.getLineAndCharacterOfPosition(node.getStart(file));
      violations.push(
        `${position.line + 1}:${position.character + 1} ${node.getText(file).slice(0, 100)}`,
      );
    }
  });
  return violations;
}

const unprotected = auditExactAppMutations(source);
assert.deepEqual(
  unprotected,
  [],
  `Exact-app mutation callsites lack executable journal dispositions:\n${unprotected.join("\n")}`,
);

const fixtureDirectory = path.join(
  root,
  "scripts",
  "fixtures",
  "mutation-audit",
);
const fixture = async (name) => {
  const text = await readFile(path.join(fixtureDirectory, name), "utf8");
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
};
const [
  strayCommandId,
  dynamicRoute,
  dynamicOperation,
  unprotectedHelper,
] = await Promise.all([
  fixture("stray-command-id.ts"),
  fixture("dynamic-route.ts"),
  fixture("dynamic-operation.ts"),
  fixture("unprotected-helper.ts"),
]);
assert.equal(
  commanderActionWiring(strayCommandId)
    .get("opencloud app restart")
    ?.has("opencloud app restart") ?? false,
  false,
  "A commandId outside a Commander action must not count as executable wiring",
);
assert.ok(
  auditExactAppMutations(dynamicRoute).length > 0,
  "A dynamic raw mutation route must fail the journal-containment audit",
);
assert.ok(
  auditExactAppMutations(dynamicOperation).length > 0,
  "An unresolved client().call operation must fail the journal-containment audit",
);
assert.ok(
  auditExactAppMutations(unprotectedHelper).length > 0,
  "A MutationRun-typed helper called outside journal.run must fail the audit",
);

process.stdout.write(
  `Mutation audit passed for ${exactRegistry.length} journal-managed exact-app dispositions, ${nonJournal.size} explicit authority/bootstrap callsites, ${registry.size} registry entries, ${leaves.size} Commander leaves, and 4 negative structural fixtures.\n`,
);
