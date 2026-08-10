function stripCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*(?:\n|$)/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\$(?<tag>[A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\k<tag>\$/g, "$$");
}

function tableBody(source: string, opening: number): string | null {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  return null;
}

function topLevelFields(body: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "(") depth += 1;
    if (body[index] === ")") depth -= 1;
    if (body[index] === "," && depth === 0) {
      fields.push(body.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(body.slice(start));
  return fields;
}

/**
 * Every app table uses the same `id` primary-key convention so all browser and
 * Function row helpers have one deterministic contract.
 */
export function validateMigrationIdConvention(sql: string): void {
  const source = stripCommentsAndLiterals(sql);
  const createTable =
    /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*\(/gi;
  for (const match of source.matchAll(createTable)) {
    const opening = (match.index ?? 0) + match[0].lastIndexOf("(");
    const body = tableBody(source, opening);
    if (body === null) continue;
    const fields = topLevelFields(body);
    const id = fields.find((field) => /^\s*(?:[iI][dD]|"id")\s+/.test(field));
    const inlinePrimaryKey = Boolean(id && /\bprimary\s+key\b/i.test(id));
    const tablePrimaryKey = fields.some((field) => {
      const primaryKey = field.match(
        /^\s*(?:constraint\s+(?:"[^"]+"|[a-z_][a-z0-9_]*)\s+)?primary\s+key\s*\(\s*([^,\s)]+)\s*\)\s*$/i,
      );
      const column = primaryKey?.[1];
      return Boolean(
        column && (column === '"id"' || /^[iI][dD]$/.test(column)),
      );
    });
    if (!inlinePrimaryKey && !tablePrimaryKey) {
      const table = match[1] ?? match[2] ?? "unknown";
      throw new Error(
        `Table ${table} must declare id as its primary key; OpenCloud row helpers always address records by id`,
      );
    }
  }
}
