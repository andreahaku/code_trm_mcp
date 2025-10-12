/**
 * TypeScript error parsing for intelligent suggestions.
 */

export type TypeScriptError = {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  suggestion?: string;
};

/**
 * Parse TypeScript compiler output into structured errors.
 */
export function parseTypeScriptErrors(output: string): TypeScriptError[] {
  const errors: TypeScriptError[] = [];

  // Match TypeScript error format: src/file.ts(27,23): error TS2339: Property 'valid' does not exist on type 'void'.
  const tsErrorRegex = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;

  let match;
  while ((match = tsErrorRegex.exec(output)) !== null) {
    const [, file, line, column, code, message] = match;

    const error: TypeScriptError = {
      file,
      line: parseInt(line, 10),
      column: parseInt(column, 10),
      code,
      message,
      suggestion: generateSuggestion(code, message)
    };

    errors.push(error);
  }

  return errors;
}

/**
 * Generate intelligent suggestions based on error code and message.
 */
function generateSuggestion(code: string, message: string): string | undefined {
  // TS2339: Property does not exist
  if (code === "TS2339") {
    if (message.includes("does not exist on type 'void'")) {
      const propMatch = message.match(/Property '(\w+)' does not exist/);
      if (propMatch) {
        return `This function returns void (has no return value). It may throw on error instead of returning a result object. Remove property access and handle via try-catch.`;
      }
    }
    if (message.includes("does not exist on type")) {
      return `Check the type definition - this property may not exist, or you may need to import the correct type.`;
    }
  }

  // TS2304: Cannot find name
  if (code === "TS2304") {
    const nameMatch = message.match(/Cannot find name '(\w+)'/);
    if (nameMatch) {
      const name = nameMatch[1];
      return `'${name}' is not imported or defined. Add the import statement or check for typos.`;
    }
  }

  // TS2345: Argument type mismatch
  if (code === "TS2345") {
    return `Argument type doesn't match parameter type. Check the function signature and adjust the argument.`;
  }

  // TS2741: Property missing in type
  if (code === "TS2741") {
    return `Object is missing required properties. Add the missing properties or make them optional in the type definition.`;
  }

  // TS2322: Type not assignable
  if (code === "TS2322") {
    return `Type mismatch in assignment. Check the types on both sides and ensure they're compatible.`;
  }

  // TS7006: Implicit 'any' type
  if (code === "TS7006") {
    return `Add explicit type annotation to avoid implicit 'any'. Use a specific type or 'unknown' for better type safety.`;
  }

  // TS2532: Object is possibly 'undefined'
  if (code === "TS2532") {
    return `Add null/undefined check before accessing. Use optional chaining (?.) or nullish coalescing (??) operator.`;
  }

  // TS2488: Type must have a Symbol.iterator
  if (code === "TS2488") {
    return `This type is not iterable. Check if it's an array or implement the iterator protocol.`;
  }

  // TS2531: Object is possibly 'null'
  if (code === "TS2531") {
    return `Add null check before accessing. Use optional chaining (?.) or check for null explicitly.`;
  }

  // TS2556: Expected N arguments, but got M
  if (code === "TS2556") {
    return `Function call has wrong number of arguments. Check the function signature and provide all required parameters.`;
  }

  // TS2769: No overload matches this call
  if (code === "TS2769") {
    return `None of the function overloads match this call. Check parameter types and counts against all available overloads.`;
  }

  return undefined;
}

/**
 * Group related errors (same file, similar error codes).
 */
export function groupRelatedErrors(errors: TypeScriptError[]): Map<string, TypeScriptError[]> {
  const grouped = new Map<string, TypeScriptError[]>();

  for (const error of errors) {
    const key = `${error.file}:${error.code}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(error);
  }

  return grouped;
}

/**
 * Format TypeScript errors for feedback.
 */
export function formatTypeScriptError(error: TypeScriptError): string {
  let formatted = `${error.file}:${error.line}:${error.column} - ${error.code}: ${error.message}`;
  if (error.suggestion) {
    formatted += `\n   💡 ${error.suggestion}`;
  }
  return formatted;
}
