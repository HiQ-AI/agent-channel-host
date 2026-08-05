export function assertMinimumToolVersion(tool: string, minimum: string, actual: string): void {
  const required = parseVersion(minimum);
  const installed = parseVersion(actual);
  if (!required || !installed) {
    throw new Error(`${tool} 版本格式无法识别：最低要求 ${minimum}，实际 ${actual}`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (installed[index]! > required[index]!) return;
    if (installed[index]! < required[index]!) {
      throw new Error(`${tool} 版本过低：最低要求 ${minimum}，实际 ${actual}`);
    }
  }
  if (installed[3] && !required[3]) {
    throw new Error(`${tool} 版本过低：最低要求 ${minimum}，实际 ${actual}`);
  }
}

function parseVersion(value: string): [number, number, number, string | null] | null {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
}
