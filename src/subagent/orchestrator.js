import fs from 'fs';
import path from 'path';
import { ContextStore } from './contextStore.js';
import { subagentWorker } from './worker.js';
import { browserController } from '../browser/browserController.js';
import { requestQueue } from '../queue/fifoQueue.js';

export class SubagentOrchestrator {
  async executeTask({ taskPrompt, outputDir = './generated_project', onProgress }) {
    console.log(`[Orchestrator] Starting multi-step coding task: "${taskPrompt.slice(0, 80)}..."`);
    const contextStore = new ContextStore(taskPrompt);

    // 1. Generate Task List (Main Agent Planning Phase)
    if (onProgress) onProgress({ phase: 'planning', message: 'Decomposing task into files...' });

    const plan = await this.generatePlan(taskPrompt);
    console.log(`[Orchestrator] Planned ${plan.length} files:`, plan.map(p => p.filePath));
    contextStore.setPlan(plan);

    if (onProgress) onProgress({ phase: 'plan_ready', plan });

    // 2. Iterate through Task List (Subagent Worker Phase)
    const targetDir = path.resolve(outputDir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (let i = 0; i < plan.length; i++) {
      const task = plan[i];
      const handover = contextStore.getHandoverContext();

      if (onProgress) {
        onProgress({
          phase: 'worker_start',
          currentFile: task.filePath,
          index: i + 1,
          total: plan.length,
        });
      }

      const result = await subagentWorker.generateFile({
        task,
        projectDescription: taskPrompt,
        handoverContext: handover,
        onProgress: (prog) => {
          if (onProgress) onProgress({ phase: 'worker_progress', ...prog });
        },
      });

      // Write file to disk
      const fullPath = path.resolve(targetDir, result.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, result.code, 'utf8');
      console.log(`[Orchestrator] Saved: ${fullPath} (${result.code.length} bytes)`);

      // Update global context store with handover summary
      contextStore.recordFileCompletion(result.filePath, result.code, result.summary, result.exports);

      if (onProgress) {
        onProgress({
          phase: 'file_written',
          filePath: result.filePath,
          fullPath,
          summary: result.summary,
        });
      }
    }

    if (onProgress) onProgress({ phase: 'done', outputDir: targetDir });

    return {
      success: true,
      outputDir: targetDir,
      plan,
      files: contextStore.getAllFiles(),
    };
  }

  async generatePlan(taskPrompt) {
    return requestQueue.enqueue(async () => {
      console.log('[Orchestrator] Initiating planning session in browser...');
      await browserController.newChat();

      const planningPrompt = `[ROLE: Senior Software Architect]
Analyze the following coding project requirement and break it down into an ordered list of files to generate.

REQUIREMENT:
${taskPrompt}

INSTRUCTIONS:
- Order files logically (e.g., configurations/schemas first, core utilities second, business logic/controllers third, entry points/tests last).
- Return ONLY a JSON array formatted as:
\`\`\`json
[
  {
    "filePath": "relative/path/to/file.ext",
    "description": "Clear explanation of this file's responsibilities and exports",
    "language": "javascript|typescript|python|html|etc",
    "dependencies": ["other/file/path.ext"]
  }
]
\`\`\`
Do not include any commentary outside the JSON code block.`;

      let fullAnswer = '';

      await new Promise((resolve, reject) => {
        browserController.sendMessage({
          prompt: planningPrompt,
          onDelta: (d) => { fullAnswer += d; },
          onDone: () => resolve(),
          onError: (e) => reject(e),
        });
      });

      return parsePlanJson(fullAnswer);
    }, { type: 'orchestrator_planning' });
  }
}

function parsePlanJson(text) {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = jsonMatch ? jsonMatch[1].trim() : text.trim();
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (e) {
    console.warn('[Orchestrator] Failed to parse JSON plan directly. Attempting fallback parse...', e.message);
  }

  // Fallback: search for first [ and last ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arrayStr = text.slice(start, end + 1);
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {}
  }

  // Minimum default fallback plan
  return [
    { filePath: 'index.js', description: 'Main application implementation', language: 'javascript' },
  ];
}

export const orchestrator = new SubagentOrchestrator();
