export const NATIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a shell command with optional working directory, timeout, and environment variables. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory for the command (default: project root)' },
          description: { type: 'string', description: 'Human-readable description of what this command does' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
          env: { type: 'object', description: 'Additional environment variables', additionalProperties: { type: 'string' } },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file. Supports reading specific line ranges.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
          offset: { type: 'number', description: 'Starting line number (1-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file, creating it if it does not exist. Overwrites existing content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Edit a file by replacing exact text matches. Uses search-and-replace with old_string/new_string pairs. The old_string must match exactly, including whitespace.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative path to the file' },
          old_string: { type: 'string', description: 'The exact text to search for (must match exactly)' },
          new_string: { type: 'string', description: 'The replacement text' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files and directories matching a glob pattern. Supports **, *, and ? wildcards.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. "src/**/*.js")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents using a regular expression pattern. Returns matching lines with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: project root)' },
          include: { type: 'string', description: 'File pattern to include (e.g. "*.js")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ListDir',
      description: 'List the contents of a directory, including files and subdirectories. Shows file sizes and modification dates.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the directory' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Fetch and retrieve the content of a URL. Returns the page content as text/markdown.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch (must be a fully-formed valid URL)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: 'Search the web for information. Returns search results with snippets and URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'CodeSearch',
      description: 'Search the codebase semantically using natural language queries. Uses vector search to find relevant code.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query about the code' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Question',
      description: 'Ask the user a question with multiple choice options or free-form input. Supports single and multiple selection.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question text to display to the user' },
          header: { type: 'string', description: 'Short header/title for the question (max 30 chars)' },
          options: {
            type: 'array',
            description: 'Available choices for the user',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text for the option' },
                description: { type: 'string', description: 'Explanation of the option' },
              },
              required: ['label'],
            },
          },
          multiple: { type: 'boolean', description: 'Allow selecting multiple options' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Task',
      description: 'Create or update a task in the task list. Used for tracking work items and sub-tasks.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Brief description of the task' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'Current status of the task',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Priority level of the task',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Actor',
      description: 'Manage sub-agents and peer agents for parallel or delegated work. Create background agents that operate independently.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the actor/agent' },
          prompt: { type: 'string', description: 'Instructions/prompt for the agent' },
          mode: {
            type: 'string',
            enum: ['subagent', 'peer'],
            description: 'Agent mode: subagent (reports back) or peer (independent)',
          },
          background: { type: 'boolean', description: 'Run in background without waiting' },
        },
        required: ['name', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Skill',
      description: 'Execute a skill - a reusable workflow or procedure defined in the project configuration.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to execute' },
          args: { type: 'object', description: 'Arguments to pass to the skill', additionalProperties: true },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Memory',
      description: 'Read from or write to the agent\'s persistent memory. Used to store and retrieve information across sessions.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'search'],
            description: 'Memory action to perform',
          },
          key: { type: 'string', description: 'Memory key to read/write' },
          value: { type: 'string', description: 'Value to write (required for write action)' },
          query: { type: 'string', description: 'Search query (required for search action)' },
        },
        required: ['action'],
      },
    },
  },
]

export const NATIVE_TOOL_NAMES = NATIVE_TOOLS.map(t => t.function.name)

export const NATIVE_TOOL_MAP = Object.fromEntries(
  NATIVE_TOOLS.map(t => [t.function.name, t])
)

export function isNativeTool(name) {
  return name in NATIVE_TOOL_MAP
}

export function findNativeTool(name) {
  const direct = NATIVE_TOOL_MAP[name]
  if (direct) return direct
  const lower = name.toLowerCase()
  return NATIVE_TOOLS.find(t => t.function.name.toLowerCase() === lower) || null
}

export function getNativeToolNames() {
  return [...NATIVE_TOOL_NAMES]
}
