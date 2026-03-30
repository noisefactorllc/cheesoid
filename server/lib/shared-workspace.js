import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { resolve, relative, join, dirname } from 'node:path'

/**
 * Build shared workspace tools for reading/writing files in a shared Docker volume.
 * Returns { definitions, handles, execute } — same pattern as buildMemoryTools/buildRoomTools.
 */
export function buildSharedWorkspaceTools(sharedRoot) {
  const definitions = [
    {
      name: 'list_shared',
      description: 'List files and directories in the shared workspace. Directory entries are shown with a trailing /.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Subdirectory path to list (optional, defaults to root of shared workspace)' },
        },
      },
    },
    {
      name: 'read_shared',
      description: 'Read a file from the shared workspace. Only files that have been previously created with write_shared will exist. Use list_shared first to see what files are available before attempting to read.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read, relative to shared workspace root. Must be a file that already exists — use list_shared to discover available files.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_shared',
      description: 'Write a file to the shared workspace. Creates parent directories automatically.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write, relative to shared workspace root' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  ]

  const toolNames = new Set(definitions.map(d => d.name))

  function safePath(inputPath) {
    const resolved = resolve(sharedRoot, inputPath)
    const rel = relative(sharedRoot, resolved)
    if (rel.startsWith('..') || resolve(sharedRoot) !== resolved.slice(0, resolve(sharedRoot).length) && rel.startsWith('..')) {
      return null
    }
    // Double-check: relative path must not start with '..'
    if (rel.startsWith('..')) {
      return null
    }
    return resolved
  }

  async function execute(name, input) {
    switch (name) {
      case 'list_shared': {
        const listPath = input.path ? safePath(input.path) : resolve(sharedRoot)
        if (!listPath) {
          return { output: 'Path resolves outside shared workspace root', is_error: true }
        }
        try {
          const entries = await readdir(listPath, { withFileTypes: true })
          if (entries.length === 0) {
            return { output: '(empty directory)' }
          }
          const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name)
          return { output: lines.join('\n') }
        } catch (err) {
          return { output: `Failed to list directory: ${err.message}`, is_error: true }
        }
      }

      case 'read_shared': {
        const filePath = safePath(input.path)
        if (!filePath) {
          return { output: 'Path resolves outside shared workspace root', is_error: true }
        }
        try {
          const content = await readFile(filePath, 'utf8')
          return { output: content }
        } catch (err) {
          if (err.code === 'ENOENT') {
            let hint = ' Use list_shared to see available files.'
            try {
              const parentDir = dirname(filePath)
              const entries = await readdir(parentDir, { withFileTypes: true })
              if (entries.length > 0) {
                const names = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name)
                hint = ` Available in ${relative(sharedRoot, parentDir) || '/'}: ${names.join(', ')}`
              }
            } catch { /* parent dir doesn't exist either */ }
            return { output: `File not found: ${input.path}.${hint}`, is_error: true }
          }
          return { output: `Failed to read file: ${err.message}`, is_error: true }
        }
      }

      case 'write_shared': {
        const filePath = safePath(input.path)
        if (!filePath) {
          return { output: 'Path resolves outside shared workspace root', is_error: true }
        }
        try {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, input.content, 'utf8')
          return { output: `Written: ${input.path}` }
        } catch (err) {
          return { output: `Failed to write file: ${err.message}`, is_error: true }
        }
      }

      default:
        return { output: `Unknown shared workspace tool: ${name}`, is_error: true }
    }
  }

  return { definitions, handles: (name) => toolNames.has(name), execute }
}
