import express from 'express';
import crypto from 'crypto';
import { config } from '../../config.js';
import { browserController } from '../../browser/browserController.js';
import { requestQueue } from '../../queue/fifoQueue.js';
import { buildPromptWithTools } from '../../toolCalling/promptWrapper.js';
import { parseResponse } from '../../toolCalling/responseParser.js';

export const chatRouter = express.Router();

chatRouter.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  const {
    messages = [],
    model = config.defaultModel,
    tools = [],
    stream = false,
    thinking_mode,
    reasoning_effort,
    thinkingMode,
  } = req.body;

  const resolvedThinkingMode = (thinking_mode || reasoning_effort || thinkingMode || 'max').toLowerCase();

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'messages must be a non-empty array',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    });
  }

  const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const createdTimestamp = Math.floor(Date.now() / 1000);
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const wrappedPrompt = buildPromptWithTools({ messages, tools });

  console.log(`[API] Received completion request (stream=${stream}, tools=${hasTools}, model=${model}, thinking=${resolvedThinkingMode})`);

  if (stream) {
    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Initial role delta
    const initialChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: createdTimestamp,
      model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

    try {
      await requestQueue.enqueue(async () => {
        // Upgrade 2: Automated clean-slate reset before every request
        await browserController.ensureCleanSlate();

        let accumulatedAnswer = '';
        let accumulatedReasoning = '';
        let streamUsage = null;

        await new Promise((resolve, reject) => {
          browserController.sendMessage({
            prompt: wrappedPrompt,
            model,
            thinkingMode: resolvedThinkingMode,
            onReasoning: (deltaReasoning) => {
              accumulatedReasoning += deltaReasoning;
              if (config.streamReasoning && !res.writableEnded) {
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: createdTimestamp,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: deltaReasoning },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            },
            onDelta: (deltaText) => {
              accumulatedAnswer += deltaText;
              // If no tools requested, stream content immediately to client
              if (!hasTools && !res.writableEnded) {
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: createdTimestamp,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: deltaText },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            },
            onUsage: (usage) => {
              streamUsage = usage;
            },
            onDone: ({ answer, usage }) => {
              if (usage) streamUsage = usage;
              const finalText = answer || accumulatedAnswer;

              if (hasTools) {
                console.log('[API] Stream finalized text length:', finalText?.length, 'sample:', JSON.stringify(finalText?.slice(0, 200)));
                // If tools were provided, inspect if the finalized text contains a tool call
                const parsed = parseResponse(finalText, tools);
                if (parsed.isToolCall && !res.writableEnded) {
                  console.log(`[API] Stream detected tool call: ${parsed.toolCalls[0].function.name}`);

                  // A. If there is introductory text before the tool call, emit it as content first
                  if (parsed.content) {
                    const contentChunk = {
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: createdTimestamp,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: { content: parsed.content },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
                  }

                  // B. Emit tool_calls delta chunk (finish_reason: null per OpenAI streaming protocol)
                  const toolChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: createdTimestamp,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: parsed.toolCalls.map((tc, idx) => ({
                            index: idx,
                            id: tc.id,
                            type: 'function',
                            function: tc.function,
                          })),
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);

                  // C. Emit completion chunk with finish_reason: 'tool_calls'
                  const finishChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: createdTimestamp,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: 'tool_calls',
                      },
                    ],
                    usage: streamUsage || undefined,
                  };
                  res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                } else if (!res.writableEnded) {
                  // Standard text response
                  const contentChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: createdTimestamp,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: finalText },
                        finish_reason: 'stop',
                      },
                    ],
                    usage: streamUsage || undefined,
                  };
                  res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
                }
              } else if (!res.writableEnded) {
                // Send finish chunk for normal stream
                const finishChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: createdTimestamp,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: 'stop',
                    },
                  ],
                  usage: streamUsage || undefined,
                };
                res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
              }

              if (!res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
              }
              resolve();
            },
            onError: (err) => {
              console.error('[API] Streaming error:', err);
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
              }
              reject(err);
            },
          });
        });
      }, { type: 'chat_stream', model });
    } catch (err) {
      console.error('[API] Stream dispatch error:', err);
      if (!res.writableEnded) {
        res.status(500).write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.end();
      }
    }
  } else {
    // Non-streaming completion
    try {
      const result = await requestQueue.enqueue(async () => {
        // Upgrade 2: Automated clean-slate reset before every request
        await browserController.ensureCleanSlate();

        let finalAnswer = '';
        let finalUsage = null;

        await new Promise((resolve, reject) => {
          browserController.sendMessage({
            prompt: wrappedPrompt,
            model,
            thinkingMode: resolvedThinkingMode,
            onDelta: (d) => { finalAnswer += d; },
            onUsage: (u) => { finalUsage = u; },
            onDone: ({ answer, usage }) => {
              finalAnswer = answer || finalAnswer;
              finalUsage = usage || finalUsage;
              resolve();
            },
            onError: (err) => reject(err),
          });
        });

        return { answer: finalAnswer, usage: finalUsage };
      }, { type: 'chat_non_stream', model });

      const parsed = parseResponse(result.answer, tools);
      const message = {
        role: 'assistant',
        content: parsed.content || null,
      };

      if (parsed.isToolCall) {
        message.tool_calls = parsed.toolCalls;
        console.log(`[API] Non-stream detected tool call: ${parsed.toolCalls[0].function.name}`);
      }

      const finishReason = parsed.isToolCall ? 'tool_calls' : 'stop';

      const responsePayload = {
        id: completionId,
        object: 'chat.completion',
        created: createdTimestamp,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReason,
          },
        ],
        usage: result.usage || {
          prompt_tokens: Math.round(wrappedPrompt.length / 4),
          completion_tokens: Math.round((result.answer || '').length / 4),
          total_tokens: Math.round((wrappedPrompt.length + (result.answer || '').length) / 4),
        },
      };

      res.json(responsePayload);
    } catch (err) {
      console.error('[API] Non-stream error:', err);
      res.status(500).json({
        error: {
          message: err.message,
          type: 'server_error',
          param: null,
          code: null,
        },
      });
    }
  }
});
