import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const definitions = [
  {
    name: 'bash',
    description: 'Run a shell command. Use for SSH, docker, curl, monitoring APIs, diagnostics.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from disk.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
]

export async function execute(name, input) {
  switch (name) {
    case 'bash': {
      try {
        const output = execSync(input.command, {
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        })
        return { output: truncate(output) }
      } catch (err) {
        return { output: truncate(err.stderr || err.message), is_error: true }
      }
    }
    case 'read_file': {
      try {
        const content = readFileSync(input.path, 'utf8')
        return { output: truncate(content) }
      } catch (err) {
        return { output: err.message, is_error: true }
      }
    }
    default:
      return { output: `Unknown tool: ${name}`, is_error: true }
  }
}

function truncate(str, max = 100_000) {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n... (truncated)'
}
