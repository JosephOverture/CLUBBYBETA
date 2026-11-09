import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.expo',
  '.next',
  'coverage',
  '.clubby-agents',
]);

export interface WorkspaceOptions {
  root: string;
  writeEnabled: boolean;
}

export class Workspace {
  readonly root: string;
  readonly writeEnabled: boolean;

  constructor(options: WorkspaceOptions) {
    this.root = path.resolve(options.root);
    this.writeEnabled = options.writeEnabled;
  }

  private resolve(relativePath: string): string {
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('\0')) throw new Error('Invalid path.');
    const absolute = path.resolve(this.root, normalized);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path escapes the repository root.');
    }
    if (relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment))) {
      throw new Error('Path targets an ignored/protected directory.');
    }
    return absolute;
  }

  async listFiles(directory = '.', limit = 250): Promise<string[]> {
    const start = this.resolve(directory === '.' ? 'README.md' : directory);
    const stat = await fs.stat(start).catch(() => undefined);
    const root = stat?.isDirectory() ? start : directory === '.' ? this.root : path.dirname(start);
    const results: string[] = [];

    const walk = async (current: string): Promise<void> => {
      if (results.length >= limit) return;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (IGNORED_SEGMENTS.has(entry.name)) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else results.push(path.relative(this.root, absolute).replaceAll(path.sep, '/'));
      }
    };

    await walk(root);
    return results;
  }

  async readFile(relativePath: string, maxChars = 30_000): Promise<string> {
    const absolute = this.resolve(relativePath);
    const value = await fs.readFile(absolute, 'utf8');
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`;
  }

  async searchText(query: string, directory = '.', limit = 80): Promise<Array<{ file: string; line: number; text: string }>> {
    if (!query.trim()) return [];
    const files = await this.listFiles(directory, 1500);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const needle = query.toLowerCase();

    for (const file of files) {
      if (matches.length >= limit) break;
      const absolute = this.resolve(file);
      const stat = await fs.stat(absolute);
      if (stat.size > 1_000_000) continue;
      let body: string;
      try {
        body = await fs.readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      const lines = body.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index] ?? '';
        if (line.toLowerCase().includes(needle)) {
          matches.push({ file, line: index + 1, text: line.slice(0, 400) });
        }
      }
    }
    return matches;
  }

  async writeFile(relativePath: string, content: string): Promise<string> {
    if (!this.writeEnabled) {
      throw new Error('Repository writes are disabled. Re-run with --write after reviewing the task.');
    }
    const absolute = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    return `Wrote ${relativePath} (${content.length} characters).`;
  }

  async replaceInFile(relativePath: string, oldText: string, newText: string): Promise<string> {
    if (!this.writeEnabled) {
      throw new Error('Repository writes are disabled. Re-run with --write after reviewing the task.');
    }
    if (!oldText) throw new Error('oldText must not be empty.');
    const absolute = this.resolve(relativePath);
    const before = await fs.readFile(absolute, 'utf8');
    const occurrences = before.split(oldText).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected oldText to occur exactly once in ${relativePath}; found ${occurrences}.`);
    }
    const after = before.replace(oldText, newText);
    await fs.writeFile(absolute, after, 'utf8');
    return `Updated ${relativePath}.`;
  }

  async gitDiff(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--', '.'], {
        cwd: this.root,
        maxBuffer: 2_000_000,
      });
      return stdout || '(no git diff)';
    } catch (error) {
      return `git diff unavailable: ${String(error)}`;
    }
  }

  async gitStatus(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], {
        cwd: this.root,
        maxBuffer: 500_000,
      });
      return stdout || '(working tree clean)';
    } catch (error) {
      return `git status unavailable: ${String(error)}`;
    }
  }

  async runCheck(check: CheckName): Promise<{ ok: boolean; command: string; output: string }> {
    const definition = CHECKS[check];
    try {
      const { stdout, stderr } = await execFileAsync(definition.command, definition.args, {
        cwd: this.root,
        maxBuffer: 4_000_000,
        env: { ...process.env, CI: '1' },
        shell: process.platform === 'win32',
      });
      return {
        ok: true,
        command: [definition.command, ...definition.args].join(' '),
        output: `${stdout}${stderr}`.slice(-80_000) || '(check passed with no output)',
      };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        command: [definition.command, ...definition.args].join(' '),
        output: `${value.stdout ?? ''}${value.stderr ?? ''}${value.message ?? ''}`.slice(-80_000),
      };
    }
  }
}

export const CHECKS = {
  typecheck: { command: 'corepack', args: ['pnpm', 'typecheck'] },
  'mobile-typecheck': { command: 'corepack', args: ['pnpm', '--filter', '@clubby/mobile', 'typecheck'] },
  'unit-tests': { command: 'corepack', args: ['pnpm', 'test'] },
  build: { command: 'corepack', args: ['pnpm', 'build'] },
} as const;

export type CheckName = keyof typeof CHECKS;
