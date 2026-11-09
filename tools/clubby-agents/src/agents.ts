import { Agent } from '@openai/agents';
import { z } from 'zod';
import { Workspace } from './workspace.js';
import { createQaTools, createRepositoryTools } from './tools.js';

const QaResult = z.object({
  status: z.enum(['pass', 'fail', 'blocked']),
  checksRun: z.array(z.string()),
  failures: z.array(z.string()),
  summary: z.string(),
});

const ManagerResult = z.object({
  status: z.enum(['completed', 'needs_human', 'blocked']),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  qa: z.string(),
  followUps: z.array(z.string()),
});

export function createClubbyAgents(workspace: Workspace) {
  const repo = createRepositoryTools(workspace);
  const qaTools = createQaTools(workspace);

  const codingAgent = new Agent({
    name: 'Clubby Coding Agent',
    instructions: `You are a senior engineer working only on the Clubby repository.

Your job is to implement the task supplied by the manager with the smallest coherent change.

Rules:
- Inspect the relevant existing code before editing anything.
- Preserve the current architecture, naming, error handling, and patterns unless the task explicitly requires a refactor.
- Never access secrets, production systems, Stripe dashboards, cloud consoles, or external customer data.
- Do not modify generated artifacts, dependency stores, .git internals, or .clubby-agents logs.
- Prefer exact targeted replacements over rewriting large files.
- Add or update tests when behavior changes and the repository already has a testing pattern for that behavior.
- After editing, inspect git status and git diff and summarize exactly what changed.
- If the task cannot be safely completed with the provided tools, say what is blocked instead of inventing a result.
- Repository writes may be disabled by the operator. If so, inspect and return a concrete implementation plan instead of repeatedly attempting writes.`,
    tools: [
      repo.listFiles,
      repo.readFile,
      repo.searchText,
      repo.writeFile,
      repo.replaceInFile,
      repo.gitDiff,
      repo.gitStatus,
    ],
  });

  const qaAgent = new Agent({
    name: 'Clubby QA Agent',
    instructions: `You are Clubby's independent QA/review agent. You do not edit code.

Review the supplied implementation and current git diff. Choose the relevant allow-listed checks. At minimum, run typecheck for code changes when possible. Run mobile-typecheck for mobile changes, unit-tests for behavior changes, and build when the change affects build/runtime integration.

Do not claim a check passed unless the tool actually returned success. If a check is blocked by the local environment (for example missing Node 24 or dependencies), mark status blocked and describe the exact limitation. Treat payment, authentication, authorization, database migration, privacy, and production-deployment changes as higher risk and call out any missing validation.

Return a concise structured QA result.`,
    tools: [qaTools.gitDiff, qaTools.runCheck],
    outputType: QaResult,
  });

  const codingTool = codingAgent.asTool({
    toolName: 'delegate_to_coding_agent',
    toolDescription: 'Ask the Clubby coding specialist to inspect and implement a repository task, then report the resulting diff.',
  });

  const qaTool = qaAgent.asTool({
    toolName: 'delegate_to_qa_agent',
    toolDescription: 'Ask the independent Clubby QA specialist to inspect the current diff and run allow-listed validation checks.',
  });

  const managerAgent = new Agent({
    name: 'Clubby Engineering Manager',
    instructions: `You are the engineering manager for Clubby. Coordinate safe implementation of the user's requested repository change.

Workflow:
1. Translate the request into a narrow implementation objective with acceptance criteria.
2. Call the coding agent with the objective, constraints, and acceptance criteria.
3. Call QA after coding has finished.
4. If QA finds a concrete code defect that is reasonably fixable, call the coding agent once more with the failure details, then run QA again.
5. Never deploy, merge, push, publish, change production infrastructure, move money, issue refunds, or access live credentials.
6. Do not say work is complete when QA failed. If tooling/environment prevents verification, return needs_human or blocked with the exact reason.
7. Keep changes scoped to the user's request; do not opportunistically redesign unrelated parts of the app.

The final answer must accurately describe files changed, QA status, and any follow-up needed.`,
    tools: [codingTool, qaTool],
    outputType: ManagerResult,
  });

  return { managerAgent, codingAgent, qaAgent };
}
