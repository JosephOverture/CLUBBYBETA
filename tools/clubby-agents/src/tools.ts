import { tool } from '@openai/agents';
import { z } from 'zod';
import { Workspace } from './workspace.js';

export function createRepositoryTools(workspace: Workspace) {
  const listFiles = tool({
    name: 'list_repository_files',
    description: 'List files in the Clubby repository. Use this before changing code to understand the relevant structure.',
    parameters: z.object({
      directory: z.string().default('.'),
      limit: z.number().int().min(1).max(500).default(200),
    }),
    execute: ({ directory, limit }) => workspace.listFiles(directory, limit),
  });

  const readFile = tool({
    name: 'read_repository_file',
    description: 'Read a UTF-8 source or configuration file from the Clubby repository.',
    parameters: z.object({
      path: z.string().min(1),
      maxChars: z.number().int().min(1000).max(60_000).default(30_000),
    }),
    execute: ({ path, maxChars }) => workspace.readFile(path, maxChars),
  });

  const searchText = tool({
    name: 'search_repository_text',
    description: 'Search source files for a text fragment and return file/line matches.',
    parameters: z.object({
      query: z.string().min(1),
      directory: z.string().default('.'),
      limit: z.number().int().min(1).max(120).default(60),
    }),
    execute: ({ query, directory, limit }) => workspace.searchText(query, directory, limit),
  });

  const writeFile = tool({
    name: 'write_repository_file',
    description: 'Create or fully replace one repository file. Writes only work when the operator explicitly launches the orchestrator with --write.',
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    execute: ({ path, content }) => workspace.writeFile(path, content),
  });

  const replaceInFile = tool({
    name: 'replace_in_repository_file',
    description: 'Safely replace one exact, unique text fragment in an existing repository file.',
    parameters: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    execute: ({ path, oldText, newText }) => workspace.replaceInFile(path, oldText, newText),
  });

  const gitDiff = tool({
    name: 'inspect_git_diff',
    description: 'Inspect the current uncommitted git diff after edits.',
    parameters: z.object({}),
    execute: () => workspace.gitDiff(),
  });

  const gitStatus = tool({
    name: 'inspect_git_status',
    description: 'Inspect which files are currently modified or untracked.',
    parameters: z.object({}),
    execute: () => workspace.gitStatus(),
  });

  return { listFiles, readFile, searchText, writeFile, replaceInFile, gitDiff, gitStatus };
}

export function createQaTools(workspace: Workspace) {
  const runCheck = tool({
    name: 'run_repository_check',
    description: 'Run one allow-listed Clubby repository validation command. Arbitrary shell commands are not permitted.',
    parameters: z.object({
      check: z.enum(['typecheck', 'mobile-typecheck', 'unit-tests', 'build']),
    }),
    execute: ({ check }) => workspace.runCheck(check),
  });

  const gitDiff = tool({
    name: 'inspect_git_diff_for_qa',
    description: 'Inspect the complete current git diff before determining QA status.',
    parameters: z.object({}),
    execute: () => workspace.gitDiff(),
  });

  return { runCheck, gitDiff };
}
