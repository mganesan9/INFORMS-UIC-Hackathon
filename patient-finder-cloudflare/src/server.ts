import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
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
      system: `You are Patient Finder Agent for a healthcare Cost Explainer workflow.

You only do patient resolution and shortlist generation.

Classify each request into one of:
- PATIENT_QUERY: user asks about a specific patient by name or ID
- PORTFOLIO_QUERY: user asks for ranked patient lists (highest/lowest cost, visits, hospitalizations, procedures, meds, or chronic conditions)
- NEEDS_CLARIFICATION: ambiguous patient reference

Rules:
- Use tools for all patient lookups.
- Names can have numeric suffixes (example: Lindsay928 Brekke496).
- Do not perform deep cost analysis. Return patient IDs and concise routing guidance.
- For portfolio asks, support both highest and lowest rankings (not just most expensive).

Return in human-readable format only (no JSON), using these exact sections:
STATUS: <PATIENT_QUERY | PORTFOLIO_QUERY | NEEDS_CLARIFICATION>
SELECTED PATIENT: <name or N/A>
SHORTLIST:
| Name | ED+Inpatient Cost | Total Visits | Total Procedures | Active Chronic Conditions | Active Medications | Hospitalizations |
|---|---:|---:|---:|---:|---:|---:|
| ... | ... | ... | ... | ... | ... | ... |
CLARIFICATION QUESTION: <question or N/A>
NEXT STEP: <single sentence handoff guidance>

Rules for output:
- Always include every section.
- Always render SHORTLIST as a markdown table (even if only one row).
- If no rows are found, include one row with N/A values.
- Do not show patient ID in the response.
- Format ED+Inpatient Cost as currency like $3,410,570 (no decimals).
- Keep output compact for one-screen readability:
  - Use at most 5 shortlist rows unless user explicitly asks for more.
  - Avoid extra blank lines.
  - Keep NEXT STEP to one short sentence.
- Never output raw JSON.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        findPatientCandidates: tool({
          description:
            "Find patient candidates by fuzzy name or patient ID. Use this for specific patient questions.",
          inputSchema: z.object({
            query: z.string().describe("Patient name or ID to resolve"),
            limit: z.number().int().min(1).max(20).default(5)
          }),
          execute: async ({ query, limit }) => {
            const normalized = query.trim().toLowerCase();
            const cleaned = normalized.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
            const q = cleaned.replaceAll("'", "''");
            const possibleId = cleaned.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
            const idCandidate = (possibleId?.[0] ?? "").replaceAll("'", "''");
            const tokens = cleaned.split(" ").filter(Boolean).slice(0, 3);
            const t1 = (tokens[0] ?? "").replaceAll("'", "''");
            const t2 = (tokens[1] ?? "").replaceAll("'", "''");
            const hasTwoTokens = t1.length > 0 && t2.length > 0;
            const splitNameMatch = hasTwoTokens
              ? `
                OR (LOWER(first) LIKE '%${t1}%' AND LOWER(last) LIKE '%${t2}%')
                OR (LOWER(first) LIKE '%${t2}%' AND LOWER(last) LIKE '%${t1}%')
              `
              : "";
            const sql = `
              SELECT
                id,
                first,
                last,
                ed_inpatient_total_cost,
                total_visits,
                (
                  SELECT COUNT(*)
                  FROM procedures p2
                  WHERE p2.PATIENT = patient_summary.id
                ) AS total_procedures,
                (
                  SELECT COUNT(*)
                  FROM conditions c2
                  WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL
                ) AS active_chronic_conditions,
                (
                  SELECT COUNT(*)
                  FROM medications m2
                  WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL
                ) AS active_medications,
                inpatient_visits AS hospitalizations,
                has_active_careplan
              FROM patient_summary
              WHERE
                LOWER(id) = '${q}'
                OR LOWER(id) = '${idCandidate}'
                OR LOWER(first || ' ' || last) LIKE '%${q}%'
                OR LOWER(first) LIKE '%${q}%'
                OR LOWER(last) LIKE '%${q}%'
                ${splitNameMatch}
              ORDER BY
                CASE
                  WHEN LOWER(id) = '${q}' THEN 0
                  WHEN LOWER(id) = '${idCandidate}' THEN 0
                  WHEN LOWER(first || ' ' || last) = '${q}' THEN 1
                  WHEN LOWER(first) = '${q}' OR LOWER(last) = '${q}' THEN 2
                  ELSE 3
                END,
                ed_inpatient_total_cost DESC
              LIMIT ${limit}
            `;

            const res = await fetch(
              "https://uic-hackathon-data.christian-7f4.workers.dev/query",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sql })
              }
            );

            return (await res.json()) as object;
          }
        }),

        listPortfolioPatients: tool({
          description:
            "Return ranked patient lists for portfolio questions. Supports highest/lowest by cost, visits, hospitalizations, procedures, active medications, and active chronic conditions.",
          inputSchema: z.object({
            metric: z
              .enum([
                "cost",
                "total_visits",
                "hospitalizations",
                "procedures",
                "active_medications",
                "active_chronic_conditions"
              ])
              .default("cost"),
            order: z.enum(["desc", "asc"]).default("desc"),
            limit: z.number().int().min(1).max(25).default(5)
          }),
          execute: async ({ metric, order, limit }) => {
            const metricExpr: Record<string, string> = {
              cost: "ed_inpatient_total_cost",
              total_visits: "total_visits",
              hospitalizations: "inpatient_visits",
              procedures: "(SELECT COUNT(*) FROM procedures p2 WHERE p2.PATIENT = patient_summary.id)",
              active_medications:
                "(SELECT COUNT(*) FROM medications m2 WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL)",
              active_chronic_conditions:
                "(SELECT COUNT(*) FROM conditions c2 WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL)"
            };
            const orderBy = metricExpr[metric] ?? metricExpr.cost;
            const sortOrder = order === "asc" ? "ASC" : "DESC";
            const sql = `
              SELECT
                id,
                first,
                last,
                ed_inpatient_total_cost,
                total_visits,
                ed_visits,
                inpatient_visits,
                (
                  SELECT COUNT(*)
                  FROM procedures p2
                  WHERE p2.PATIENT = patient_summary.id
                ) AS total_procedures,
                (
                  SELECT COUNT(*)
                  FROM conditions c2
                  WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL
                ) AS active_chronic_conditions,
                (
                  SELECT COUNT(*)
                  FROM medications m2
                  WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL
                ) AS active_medications,
                inpatient_visits AS hospitalizations,
                has_active_careplan
              FROM patient_summary
              ORDER BY ${orderBy} ${sortOrder}
              LIMIT ${limit}
            `;

            const res = await fetch(
              "https://uic-hackathon-data.christian-7f4.workers.dev/query",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sql })
              }
            );

            return (await res.json()) as object;
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
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
