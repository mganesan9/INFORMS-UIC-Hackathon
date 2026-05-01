import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage
} from "ai";
import { z } from "zod";
import { IntentAgent } from "./intent-agent";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a cost analytics agent for a value-based primary care practice. Your job is to help care managers understand WHY patients are expensive and WHICH costs can be reduced.

You operate in a multi-agent architecture:
- **Intent Agent** (you are here): Route user queries to appropriate specialists
- **Cost Analyst Agent**: Deep-dive into individual patient costs and drivers
- **Patient Finder Agent**: Rank and filter population-level queries
- **Narrative Generator**: Create plain-language briefings

## YOUR FIRST STEP: Always classify the user's intent

BEFORE doing anything else, use the **classifyIntent** tool on their question. This tells you:
1. Are they asking about a specific patient? → Route to Cost Analyst
2. Are they asking about the whole population? → Route to Patient Finder
3. Is their question ambiguous? → Ask for clarification

## Then respond based on intent:

**Portfolio Analysis** (population question): "Who are my most expensive patients?"
- Query patient_summary ranked by cost
- Show top 10-15 with costs, ED visits, inpatient days
- Highlight patterns

**Patient Specific** (named patient): "Tell me about Giovanni Paucek's costs"
- Find the patient by name (use LIKE with LOWER for Synthea data)
- Drill into encounters, claims_transactions (JOIN on PATIENTID), procedures, conditions
- Identify cost drivers: high ED use? Polypharmacy? Chronic conditions without follow-up?
- Flag avoidable patterns

**Patient Search** (criteria-based): "Find patients with >10 ED visits"
- Filter patient_summary by condition
- Present ranked results
- Offer follow-up: "Want to know more about any of these?"

**Clarification** (ambiguous): Ask the user to clarify

## Important Notes:
- Always use classifyIntent first for every new user query
- Never show raw JSON — format as tables or summaries
- Always include LIMIT clauses in SQL queries
- claims_transactions joins on PATIENTID (not PATIENT) — this is a gotcha!
- Synthea names have numeric suffixes and mixed case (e.g., Giovanni385 Paucek755) — use LIKE LOWER()`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Intent Classification: Route to appropriate sub-agent
        classifyIntent: tool({
          description:
            "Classify the user's intent and route to appropriate analysis. " +
            "Understands portfolio questions (population-level), patient-specific queries, and search requests. " +
            "Always use this first to interpret user intent.",
          inputSchema: z.object({
            userQuery: z.string().describe("The user's natural language question or request"),
          }),
          execute: async ({ userQuery }) => {
            const result = IntentAgent.classifyIntent(userQuery);
            return {
              intent: result.intent,
              confidence: result.confidence,
              reasoning: result.reasoning,
              patientIdentifier: result.patientIdentifier,
              userFacingMessage: IntentAgent.formatIntentResponse(result),
              sqlHint: IntentAgent.getSQLHint(result),
            };
          },
        }),

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            // Replace with a real weather API in production
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        queryDatabase: tool({
          description:
            "Execute a SQL SELECT query against the patient dataset. " +
            "Use patient_summary as your starting point — it has one row per patient " +
            "with pre-computed visit counts, costs, and care plan flags. " +
            "Tables: patients, encounters, conditions, medications, " +
            "observations, procedures, claims_transactions, careplans. " +
            "IMPORTANT: claims_transactions joins on PATIENTID, not PATIENT.",
          inputSchema: z.object({
            sql: z.string().describe("A valid SQL SELECT statement. Always include a LIMIT clause."),
          }),
          execute: async ({ sql }) => {
            const res = await fetch(
              "https://uic-hackathon-data.christian-7f4.workers.dev/query",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sql }),
              }
            );
            return res.json() as object;
          }
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
