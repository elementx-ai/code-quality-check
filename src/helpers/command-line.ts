// eslint-disable-next-line complexity
export const splitCommandLine = (commandLine: string): string[] => {
  const tokens: string[] = [];
  let currentToken = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const character of commandLine.trim()) {
    if (escaping) {
      currentToken += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        currentToken += character;
      }

      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = "";
      }

      continue;
    }

    currentToken += character;
  }

  if (escaping || quote) {
    throw new Error(`Unable to parse command: ${commandLine}`);
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  if (tokens.length === 0) {
    throw new Error("Configured command was empty.");
  }

  return tokens;
};

// eslint-disable-next-line complexity
export const hasUnquotedShellOperatorToken = (commandLine: string): boolean => {
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === ";" || character === "|") {
      return true;
    }

    if (
      character === "&" &&
      index + 1 < commandLine.length &&
      commandLine[index + 1] === "&"
    ) {
      return true;
    }
  }

  return false;
};
