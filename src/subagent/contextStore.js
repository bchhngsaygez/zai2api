/**
 * Manages shared global context and concise handover summaries
 * across subagent sessions.
 */

export class ContextStore {
  constructor(taskDescription = '') {
    this.taskDescription = taskDescription;
    this.plan = [];
    this.completedFiles = new Map(); // filePath -> { content, summary, exports }
  }

  setPlan(fileTasks) {
    this.plan = fileTasks;
  }

  recordFileCompletion(filePath, content, summary, exports = []) {
    this.completedFiles.set(filePath, {
      content,
      summary,
      exports,
      timestamp: Date.now(),
    });
  }

  /**
   * Generates a minimal, highly concentrated handover context
   * to provide to the next subagent worker without overflowing context.
   */
  getHandoverContext() {
    if (this.completedFiles.size === 0) {
      return 'No prior files generated yet. This is the first file.';
    }

    const summaries = [];
    for (const [filePath, data] of this.completedFiles.entries()) {
      summaries.push(`- **File**: \`${filePath}\`
  - **Summary**: ${data.summary}
  - **Exported Interfaces/Functions**:
    ${Array.isArray(data.exports) && data.exports.length > 0 ? data.exports.map(e => `\`${e}\``).join(', ') : 'None / Default export'}`);
    }

    return `### Previously Generated Files & Interfaces Handover:\n${summaries.join('\n')}`;
  }

  getAllFiles() {
    const result = {};
    for (const [filePath, data] of this.completedFiles.entries()) {
      result[filePath] = data.content;
    }
    return result;
  }
}
