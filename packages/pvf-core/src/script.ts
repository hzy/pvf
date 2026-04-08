import { float32Buffer, int32Buffer } from "./codec.ts";
import { MutableStringTable } from "./string-table.ts";

interface CompiledScriptToken {
  kind: "continue" | "link" | "value";
  type?: number;
  data?: Buffer;
}

function getDataFromFormat(source: string, header: string, ending: string): string {
  let start = header.length > 0 ? source.indexOf(header) : 0;

  if (start === -1) {
    return "";
  }

  start += header.length;
  const sliced = source.slice(start);

  if (ending.length === 0) {
    return sliced;
  }

  const end = sliced.indexOf(ending);
  return end === -1 ? "" : sliced.slice(0, end);
}

function compileScriptItem(itemData: string, stringTable: MutableStringTable): CompiledScriptToken {
  if (itemData.length === 0) {
    throw new Error("Cannot compile an empty script token.");
  }

  if (itemData.startsWith("[") && itemData.endsWith("]")) {
    return {
      kind: "value",
      type: 5,
      data: int32Buffer(stringTable.getOrAdd(itemData)),
    };
  }

  if (itemData.startsWith("<") && itemData.endsWith(">")) {
    return {
      kind: "link",
    };
  }

  if (itemData.startsWith("`") && itemData.endsWith("`")) {
    return {
      kind: "value",
      type: 7,
      data: int32Buffer(stringTable.getOrAdd(getDataFromFormat(itemData, "`", "`"))),
    };
  }

  if (itemData.startsWith("{") && itemData.endsWith("}")) {
    const opcodeText = getDataFromFormat(itemData, "{", "=");
    const rawValue = getDataFromFormat(itemData, "=", "}");
    const opcode = Number.parseInt(opcodeText, 10);

    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 255) {
      throw new Error(`Unsupported script opcode: ${itemData}`);
    }

    if (rawValue.startsWith("`") && rawValue.endsWith("`")) {
      return {
        kind: "value",
        type: opcode,
        data: int32Buffer(stringTable.getOrAdd(getDataFromFormat(rawValue, "`", "`"))),
      };
    }

    const numericValue = Number.parseInt(rawValue, 10);

    if (!Number.isInteger(numericValue)) {
      throw new Error(`Unsupported command payload: ${itemData}`);
    }

    return {
      kind: "value",
      type: opcode,
      data: int32Buffer(numericValue),
    };
  }

  if (itemData.startsWith("`")) {
    return {
      kind: "continue",
    };
  }

  if (!itemData.includes(".")) {
    const value = Number.parseInt(itemData, 10);

    if (!Number.isInteger(value)) {
      throw new Error(`Invalid integer token: ${itemData}`);
    }

    return {
      kind: "value",
      type: 2,
      data: int32Buffer(value),
    };
  }

  const floatValue = Number.parseFloat(itemData);

  if (Number.isNaN(floatValue)) {
    throw new Error(`Invalid float token: ${itemData}`);
  }

  return {
    kind: "value",
    type: 4,
    data: float32Buffer(floatValue),
  };
}

function writeCompiledToken(output: Buffer[], token: CompiledScriptToken): void {
  if (token.kind !== "value" || token.type === undefined || !token.data) {
    throw new Error("Only value tokens can be written directly.");
  }

  output.push(Buffer.from([token.type]), token.data);
}

function compileType10Token(itemData: string, stringTable: MutableStringTable): Buffer {
  const indexText = getDataFromFormat(itemData, "<", "::");
  const linkIndex = Number.parseInt(indexText, 10);
  const key = getDataFromFormat(itemData, "::", "`");

  if (!Number.isInteger(linkIndex) || key.length === 0) {
    throw new Error(`Invalid link token: ${itemData}`);
  }

  return Buffer.concat([
    Buffer.from([9]),
    int32Buffer(linkIndex),
    Buffer.from([10]),
    int32Buffer(stringTable.getOrAdd(key)),
  ]);
}

export function compilePvfScriptText(scriptText: string, stringTable: MutableStringTable): Buffer {
  const lines = scriptText.replace(/\r\n/gu, "\n").split("\n");
  const output: Buffer[] = [Buffer.from([0xb0, 0xd0])];
  let pending = "";

  for (const line of lines) {
    if (pending.length > 0) {
      pending += line;
      const compiled = compileScriptItem(pending, stringTable);

      if (compiled.kind === "continue") {
        pending += "\r\n";
        continue;
      }

      if (compiled.kind === "link") {
        output.push(compileType10Token(pending, stringTable));
        pending = "";
        continue;
      }

      writeCompiledToken(output, compiled);
      pending = "";
      continue;
    }

    const lowerLine = line.toLowerCase();

    if (lowerLine === "#pvf_file" || lowerLine === "#pvf_file_add" || line.length === 0) {
      continue;
    }

    const items = line.split("\t").filter((item) => item.length > 0);

    for (const item of items) {
      pending += item;
      const compiled = compileScriptItem(pending, stringTable);

      if (compiled.kind === "continue") {
        pending += "\r\n";
        continue;
      }

      if (compiled.kind === "link") {
        output.push(compileType10Token(pending, stringTable));
        pending = "";
        continue;
      }

      writeCompiledToken(output, compiled);
      pending = "";
    }
  }

  if (pending.length > 0) {
    throw new Error(`Unterminated script token: ${pending}`);
  }

  return Buffer.concat(output);
}
