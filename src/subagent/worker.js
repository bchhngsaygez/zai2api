import { browserController } from '../browser/browserController.js';
import { requestQueue } from '../queue/fifoQueue.js';

export class SubagentWorker {
  async generateFile({ task, projectDescription, handoverContext, onProgress }) {
    if (onProgress) {
      onProgress({ status: 'starting', file: task.filePath });
    }

    // Wrap in requestQueue to ensure single tab FIFO serialization
    return requestQueue.enqueue(async () => {
      // 1. Open a New Chat to clear DOM and conversational context
      console.log(`[Subagent Worker] Opening New Chat for file: ${task.filePath}`);
      await browserController.newChat();

      // 2. Build minimal context prompt
      const prompt = `[ROLE: Specialised Subagent Worker]
You are creating ONE specific source code file for this project.

[PROJECT OVERVIEW]
${projectDescription}

[HANDOVER CONTEXT FROM PRIOR FILES]
${handoverContext}

[TARGET FILE TASK]
File Path: ${task.filePath}
Purpose: ${task.description}
Required Dependencies & Imports: ${task.dependencies ? task.dependencies.join(', ') : 'Standard project modules'}

[OUTPUT FORMAT REQUIREMENT]
Provide your output in exactly two sections:
SECTION 1: HANDOVER SUMMARY (YAML format in a \`\`\`yaml code block):
\`\`\`yaml
summary: "Brief 1-2 sentence description of what this file implements"
exports:
  - name_of_exported_symbol
\`\`\`

SECTION 2: FULL SOURCE CODE (in a single code block matching the language):
\`\`\`${task.language || ''}
// full code for ${task.filePath}
\`\`\`

Do not leave any placeholder comments like "// TODO" or "// implement later". Produce production-ready code.`;

      let fullAnswer = '';

      if (onProgress) {
        onProgress({ status: 'generating', file: task.filePath });
      }

      await new Promise((resolve, reject) => {
        browserController.sendMessage({
          prompt,
          onDelta: (delta) => {
            fullAnswer += delta;
            if (onProgress) onProgress({ status: 'delta', delta, file: task.filePath });
          },
          onDone: () => resolve(),
          onError: (err) => reject(err),
        });
      });

      // 3. Parse code block and summary
      const parsed = parseWorkerResponse(fullAnswer, task.filePath);
      console.log(`[Subagent Worker] Finished file ${task.filePath}. Extracted ${parsed.code.length} bytes of code.`);

      if (onProgress) {
        onProgress({ status: 'completed', file: task.filePath, summary: parsed.summary });
      }

      return parsed;
    }, { type: 'subagent_worker', file: task.filePath });
  }
}

function parseWorkerResponse(text, defaultPath) {
  let summary = `Generated file ${defaultPath}`;
  let exportsList = [];
  let code = '';

  // Extract YAML block for summary/exports
  const yamlMatch = text.match(/```(?:yaml|json)?\s*([\s\S]*?summary:[\s\S]*?)```/i);
  if (yamlMatch) {
    const yamlStr = yamlMatch[1];
    const summaryMatch = yamlStr.match(/summary:\s*["']?([^"'\n\r]+)["']?/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    }
    const exportsMatches = [...yamlStr.matchAll(/-\s*([a-zA-Z0-9_$]+)/g)];
    if (exportsMatches.length > 0) {
      exportsList = exportsMatches.map(m => m[1]);
    }
  }

  // Extract all code blocks and pick the longest one (which is the source code)
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let match;
  let longestBlock = '';

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.includes('summary:') && content.length < 300) {
      continue; // Skip summary block
    }
    if (content.length > longestBlock.length) {
      longestBlock = content;
    }
  }

  code = longestBlock || text;

  return {
    filePath: defaultPath,
    code,
    summary,
    exports: exportsList,
  };
}

export const subagentWorker = new SubagentWorker();
