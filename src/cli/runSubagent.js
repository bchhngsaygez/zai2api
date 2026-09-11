import path from 'path';
import { browserController } from '../browser/browserController.js';
import { orchestrator } from '../subagent/orchestrator.js';

async function main() {
  const args = process.argv.slice(2);
  let taskPrompt = '';
  let outputDir = './generated_project';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' || args[i] === '-o') {
      outputDir = args[i + 1];
      i++;
    } else if (!taskPrompt) {
      taskPrompt = args[i];
    }
  }

  if (!taskPrompt) {
    taskPrompt = 'Create a simple Node.js HTTP server with a router and an in-memory item store across 2 files: server.js and store.js';
    console.log(`[CLI] No prompt specified. Defaulting to demo prompt:\n"${taskPrompt}"\n`);
  }

  console.log('=====================================================');
  console.log('   Z.ai Subagent Multi-File Code Generator');
  console.log('=====================================================');
  console.log(`Task: ${taskPrompt}`);
  console.log(`Output Directory: ${path.resolve(outputDir)}\n`);

  try {
    await browserController.initialize();

    const result = await orchestrator.executeTask({
      taskPrompt,
      outputDir,
      onProgress: (event) => {
        if (event.phase === 'planning') {
          console.log('\n[Orchestrator] Planning project files...');
        } else if (event.phase === 'plan_ready') {
          console.log(`[Orchestrator] Generated plan with ${event.plan.length} files:`);
          event.plan.forEach((p, idx) => console.log(`  ${idx + 1}. ${p.filePath} - ${p.description}`));
        } else if (event.phase === 'worker_start') {
          console.log(`\n[Worker] (${event.index}/${event.total}) Starting generation for: ${event.currentFile}`);
        } else if (event.phase === 'file_written') {
          console.log(`[Worker] Successfully wrote: ${event.filePath}`);
          console.log(`  Summary: ${event.summary}`);
        } else if (event.phase === 'done') {
          console.log('\n=====================================================');
          console.log('   All files generated successfully!');
          console.log('=====================================================');
          console.log(`Output directory: ${event.outputDir}`);
        }
      },
    });

    await browserController.close();
    process.exit(0);
  } catch (err) {
    console.error('\n[Error] Subagent execution failed:', err);
    await browserController.close().catch(() => {});
    process.exit(1);
  }
}

main();
