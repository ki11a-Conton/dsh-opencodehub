/**
 * Tool mapping — port of tools.go.
 *
 * Upstream gate: every chat request's tools array MUST contain the exact
 * lowercase ids `read` and `bash`, or the upstream answers 403. Clients using
 * other spellings get an outbound rename; undeclared gate tools get a
 * placeholder injected upstream (marked "must never be called"); placeholder
 * calls coming back are dropped and a tool-calls finish collapses back to stop.
 */

export const REQUIRED_GATE_TOOLS = ['read', 'bash'];

const READ_PLACEHOLDER_DESC =
  "Placeholder for OpenCode's built-in file reader. It is NOT available in this session: must never be called, and any such call is discarded.";
const BASH_PLACEHOLDER_DESC =
  "Placeholder for OpenCode's built-in shell. It is NOT available in this session: must never be called, and any such call is discarded.";

function placeholderTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: name === 'read' ? READ_PLACEHOLDER_DESC : BASH_PLACEHOLDER_DESC,
      parameters: { type: 'object', properties: {} },
    },
  };
}

/**
 * Bidirectional rename table. Matching is case-insensitive on the declared
 * tool name; the FIRST declaration wins for a given lowercase key.
 */
export class ToolMapper {
  constructor() {
    /** lowercase upstream name → client-declared exact spelling */
    this.clientName = new Map();
    /** client exact spelling → upstream lowercase name */
    this.upstreamName = new Map();
  }

  declare(clientSpelling) {
    const lower = clientSpelling.toLowerCase();
    if (this.clientName.has(lower)) return;
    this.clientName.set(lower, clientSpelling);
    this.upstreamName.set(clientSpelling, lower);
  }

  /** @returns the upstream (lowercase) name to send, or the original when unmapped */
  upstreamOf(clientSpelling) {
    return this.upstreamName.get(clientSpelling) ?? clientSpelling;
  }

  /** @returns the client exact spelling for an upstream name, else the input */
  clientOf(upstreamName) {
    return this.clientName.get(upstreamName.toLowerCase()) ?? upstreamName;
  }

  isDeclared(upstreamLowerName) {
    return this.clientName.has(upstreamLowerName);
  }

  declaredGateTools() {
    return REQUIRED_GATE_TOOLS.filter((name) => this.clientName.has(name));
  }
}

/**
 * Port of tools.go newToolMapper + upstreamToolList: walk the client tools,
 * record mappings, rename outbound, inject placeholders for gate tools the
 * client did not declare. Accepts OpenAI wire shape ({function:{name}}) and
 * flat shape ({name}).
 * @param {Array<object>} tools
 * @returns {{mapper: ToolMapper, upstreamTools: Array}}
 */
export function upstreamToolList(tools) {
  const mapper = new ToolMapper();
  for (const tool of tools ?? []) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string' && name.length > 0) {
      mapper.declare(name);
    }
  }
  const upstreamTools = (tools ?? []).map((tool) => {
    if (tool?.function?.name !== undefined) {
      return { ...tool, function: { ...tool.function, name: mapper.upstreamOf(tool.function.name) } };
    }
    return { ...tool, name: mapper.upstreamOf(tool.name) };
  });
  for (const gate of REQUIRED_GATE_TOOLS) {
    if (!mapper.isDeclared(gate)) {
      upstreamTools.push(placeholderTool(gate));
    }
  }
  return { mapper, upstreamTools };
}

/**
 * Port of tools.go toolCallDeltaFilter. One instance tracks one request's
 * response stream: which tool-call indexes were dropped and whether any
 * client-visible call appeared.
 */
export class DeltaToolFilter {
  constructor(mapper) {
    this.mapper = mapper;
    this.dropped = new Set();
    this.sawCall = false;
  }

  /**
   * Mutate one SSE chunk's choices[0].delta in place.
   * @param {object} delta chunk delta with optional tool_calls array
   */
  filter(delta) {
    const calls = delta.tool_calls;
    if (!Array.isArray(calls)) return;
    const kept = [];
    for (const call of calls) {
      const idx = typeof call.index === 'number' ? call.index : 0;
      const name = call?.function?.name; // may be null (Go: type assertion fails → "")
      if (typeof name === 'string' && name !== '') {
        const lower = name.toLowerCase();
        if (REQUIRED_GATE_TOOLS.includes(lower)) {
          if (this.mapper.isDeclared(lower)) {
            call.function.name = this.mapper.clientOf(name);
          } else {
            this.dropped.add(idx);
            continue;
          }
        }
        // Any named, surviving call counts (Go sets sawCall in both the
        // renamed-gate branch and the untouched-client-tool branch).
        this.sawCall = true;
        kept.push(call);
      } else if (this.dropped.has(idx)) {
        // argument continuation of a dropped placeholder call: discard
      } else {
        kept.push(call);
      }
    }
    if (kept.length === 0) delete delta.tool_calls;
    else delta.tool_calls = kept;
  }
}
