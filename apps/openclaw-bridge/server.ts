/**
 * OpenClaw Bridge — A lightweight server that bridges SkyTwin's OpenClaw
 * adapter to a local Ollama instance. This gives the decision pipeline
 * real LLM reasoning using whatever model you have installed.
 *
 * Usage:
 *   npx tsx apps/openclaw-bridge/server.ts
 *
 * Environment:
 *   OLLAMA_HOST    — Ollama API base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL   — Model to use (default: gemma:latest)
 *   BRIDGE_PORT    — Port to listen on (default: 4100)
 */

const OLLAMA_HOST = process.env['OLLAMA_HOST'] || 'http://localhost:11434';
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] || 'gemma:latest';
const PORT = parseInt(process.env['BRIDGE_PORT'] || '4100', 10);

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ── Helpers ────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Ollama call ────────────────────────────────────────

async function askOllama(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 512,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${text}`);
  }

  const result = await response.json() as { response: string };
  return result.response;
}

// ── Route handlers ─────────────────────────────────────

async function handleExecute(body: string, res: ServerResponse) {
  const request = JSON.parse(body) as {
    planId: string;
    decisionId: string;
    action: {
      type: string;
      description: string;
      parameters: Record<string, unknown>;
      domain: string;
    };
    steps: Array<{
      id: string;
      type: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  };

  console.log(`[openclaw-bridge] Executing: ${request.action.type} — "${request.action.description}"`);

  // Build a prompt for the LLM to reason about the action
  const prompt = `You are a personal AI assistant executing an action on behalf of a user.

ACTION TO EXECUTE:
- Type: ${request.action.type}
- Description: ${request.action.description}
- Domain: ${request.action.domain}
${request.action.parameters ? `- Parameters: ${JSON.stringify(request.action.parameters, null, 2)}` : ''}

STEPS:
${request.steps.map((s, i) => `${i + 1}. [${s.type}] ${s.description}`).join('\n')}

Think through how you would execute this action step by step. Then provide:
1. A brief summary of what you did (1-2 sentences)
2. Whether this was successful
3. Any relevant output data

Respond in this JSON format only:
{
  "summary": "...",
  "success": true,
  "reasoning": "...",
  "output_data": {}
}`;

  const startTime = Date.now();

  try {
    const llmResponse = await askOllama(prompt);
    const elapsed = Date.now() - startTime;
    console.log(`[openclaw-bridge] LLM responded in ${elapsed}ms`);

    // Try to parse structured response from LLM
    let parsed: Record<string, unknown> = {};
    try {
      // Find JSON in the response
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // LLM didn't return valid JSON — use the raw text
      parsed = { summary: llmResponse.slice(0, 200), success: true };
    }

    json(res, 200, {
      status: 'completed',
      adapter: 'openclaw-bridge',
      model: OLLAMA_MODEL,
      planId: request.planId,
      actionType: request.action.type,
      llmReasoning: parsed['reasoning'] || parsed['summary'] || llmResponse.slice(0, 300),
      summary: parsed['summary'] || `Executed ${request.action.type} via ${OLLAMA_MODEL}`,
      outputData: parsed['output_data'] || {},
      latencyMs: elapsed,
    });
  } catch (err) {
    console.error(`[openclaw-bridge] LLM error:`, err);
    json(res, 500, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleHealth(_body: string, res: ServerResponse) {
  try {
    // Check Ollama is reachable
    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await ollamaRes.json() as { models: Array<{ name: string }> };
    const models = data.models?.map((m: { name: string }) => m.name) ?? [];
    const hasModel = models.some((m: string) => m === OLLAMA_MODEL || m.startsWith(OLLAMA_MODEL.split(':')[0]!));

    json(res, 200, {
      status: 'ok',
      service: 'openclaw-bridge',
      ollamaHost: OLLAMA_HOST,
      model: OLLAMA_MODEL,
      modelAvailable: hasModel,
      availableModels: models,
    });
  } catch (err) {
    json(res, 503, {
      status: 'unhealthy',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleRollback(body: string, res: ServerResponse) {
  const request = JSON.parse(body);
  console.log(`[openclaw-bridge] Rollback requested for plan: ${request.planId}`);
  json(res, 200, {
    status: 'rolled_back',
    planId: request.planId,
    message: 'Rollback acknowledged (simulated in bridge mode)',
  });
}

// ── Server ─────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const body = req.method === 'POST' ? await readBody(req) : '';

  try {
    if (req.url === '/health' && req.method === 'GET') {
      await handleHealth(body, res);
    } else if (req.url === '/execute' && req.method === 'POST') {
      await handleExecute(body, res);
    } else if (req.url === '/rollback' && req.method === 'POST') {
      await handleRollback(body, res);
    } else {
      json(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error(`[openclaw-bridge] Error:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[openclaw-bridge] Listening on http://localhost:${PORT}`);
  console.log(`[openclaw-bridge] Ollama: ${OLLAMA_HOST} (model: ${OLLAMA_MODEL})`);
  console.log(`[openclaw-bridge] Endpoints:`);
  console.log(`  GET  /health   — health check`);
  console.log(`  POST /execute  — execute action via LLM`);
  console.log(`  POST /rollback — rollback action`);
});
