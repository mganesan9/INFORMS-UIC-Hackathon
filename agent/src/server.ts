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
- **Intent Agent** (you are here): Classify and route every query
- **Patient Finder Agent**: Portfolio and search queries — call listPortfolioPatients or findPatientCandidates
- **Cost Analyst Agent**: Individual patient deep-dive — call runCostAnalysis
- **Narrative Generator**: You synthesize findings into plain-language output

## YOUR FIRST STEP: Always classify the user's intent

BEFORE doing anything else, use the **classifyIntent** tool. It returns one of four intents:

1. **portfolio_analysis** → Call **listPortfolioPatients** (ranked population lists)
2. **patient_specific** → Call **runCostAnalysis** (full cost deep-dive on that patient)
3. **patient_search** → Call **findPatientCandidates** (fuzzy name/criteria search)
4. **clarification** → Ask the user to clarify

## How to respond for each intent:

**portfolio_analysis** — "Who are my most expensive patients?" / "Top patients by ED visits"
- Call **listPortfolioPatients** with the right metric and order
- Render ONLY a markdown table with these columns: Name | ED+Inpatient Cost | Total Visits | Hospitalizations | Active Conditions | Active Meds | Care Plan
- Do NOT add any commentary, patterns, flags, or analysis after the table
- End with exactly one line: "Want a full cost analysis on any of these patients?"

**patient_specific** — "Tell me about Giovanni Paucek's costs" / "Why is Lindsay Brekke expensive?"
- Call **runCostAnalysis** with the patient name
- After the tool returns its result, you MUST immediately render both tables below — never stop after the tool call without rendering them

**📋 Why This Patient's Costs Are High**
| # | Cost Driver | Key Fact | Why It Matters |
|---|---|---|---|
Exactly 5 rows. Plain language only — no clinical jargon. Lead Key Fact with the most important number (e.g. "Went to the ER 44 times", not "high ED utilization").

**✅ What the Care Manager Should Do**
| Priority | Action | Owner | When |
|---|---|---|---|
Exactly 5 rows. Sorted URGENT → HIGH → MEDIUM. One concrete action per row with owner and timeframe.

- End with exactly one line: "Want me to draft an outreach message or full care plan for [patient name]?"

**patient_search** — "Find patients with >10 ED visits" / "Show me diabetics without care plans"
- Call **findPatientCandidates** with the search criteria as the query
- Render as a markdown table
- Offer follow-up: "Want a full cost analysis on any of these?"

**clarification** — Only use this if the query contains a partial name with multiple possible matches, or is completely unrelated to patients. NEVER ask for clarification on ranking, listing, or "top N" queries — always treat those as portfolio_analysis.

## Important Notes:
- Always use classifyIntent first for every new user query
- Never show raw JSON — always render as markdown tables
- Synthea names have numeric suffixes (e.g., Giovanni385 Paucek755) — findPatientCandidates and runCostAnalysis handle this automatically
- claims_transactions joins on PATIENTID not PATIENT — runCostAnalysis handles this`,
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

        // ── Patient Finder Agent tools (from Manav's patient-finder-cloudflare) ──

        findPatientCandidates: tool({
          description:
            "Find patient candidates by fuzzy name or patient ID. " +
            "Use for patient_search intent or when resolving a patient name before cost analysis. " +
            "Handles Synthea numeric suffixes automatically.",
          inputSchema: z.object({
            query: z.string().describe("Patient name or ID to resolve"),
            limit: z.number().int().min(1).max(20).default(5),
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
              ? `OR (LOWER(first) LIKE '%${t1}%' AND LOWER(last) LIKE '%${t2}%')
                 OR (LOWER(first) LIKE '%${t2}%' AND LOWER(last) LIKE '%${t1}%')`
              : "";
            const sql = `
              SELECT id, first, last, ed_inpatient_total_cost, total_visits,
                (SELECT COUNT(*) FROM procedures p2 WHERE p2.PATIENT = patient_summary.id) AS total_procedures,
                (SELECT COUNT(*) FROM conditions c2 WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL) AS active_chronic_conditions,
                (SELECT COUNT(*) FROM medications m2 WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL) AS active_medications,
                inpatient_visits AS hospitalizations, has_active_careplan
              FROM patient_summary
              WHERE LOWER(id) = '${q}' OR LOWER(id) = '${idCandidate}'
                OR LOWER(first || ' ' || last) LIKE '%${q}%'
                OR LOWER(first) LIKE '%${q}%' OR LOWER(last) LIKE '%${q}%'
                ${splitNameMatch}
              ORDER BY
                CASE
                  WHEN LOWER(id) = '${q}' THEN 0
                  WHEN LOWER(first || ' ' || last) = '${q}' THEN 1
                  WHEN LOWER(first) = '${q}' OR LOWER(last) = '${q}' THEN 2
                  ELSE 3
                END, ed_inpatient_total_cost DESC
              LIMIT ${limit}`;
            const res = await fetch("https://uic-hackathon-data.christian-7f4.workers.dev/query", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sql }),
            });
            return res.json() as object;
          },
        }),

        listPortfolioPatients: tool({
          description:
            "Return a ranked patient list for portfolio/population questions. " +
            "Use for portfolio_analysis intent. Supports ranking by cost, total_visits, " +
            "hospitalizations, procedures, active_medications, or active_chronic_conditions, " +
            "in ascending or descending order.",
          inputSchema: z.object({
            metric: z.enum(["cost", "total_visits", "hospitalizations", "procedures", "active_medications", "active_chronic_conditions"]).default("cost"),
            order: z.enum(["desc", "asc"]).default("desc"),
            limit: z.number().int().min(1).max(25).default(10),
          }),
          execute: async ({ metric, order, limit }) => {
            const metricExpr: Record<string, string> = {
              cost: "ed_inpatient_total_cost",
              total_visits: "total_visits",
              hospitalizations: "inpatient_visits",
              procedures: "(SELECT COUNT(*) FROM procedures p2 WHERE p2.PATIENT = patient_summary.id)",
              active_medications: "(SELECT COUNT(*) FROM medications m2 WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL)",
              active_chronic_conditions: "(SELECT COUNT(*) FROM conditions c2 WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL)",
            };
            const orderBy = metricExpr[metric] ?? metricExpr.cost;
            const sql = `
              SELECT first, last, ed_inpatient_total_cost, total_visits, ed_visits, inpatient_visits,
                (SELECT COUNT(*) FROM procedures p2 WHERE p2.PATIENT = patient_summary.id) AS total_procedures,
                (SELECT COUNT(*) FROM conditions c2 WHERE c2.PATIENT = patient_summary.id AND c2.STOP IS NULL) AS active_chronic_conditions,
                (SELECT COUNT(*) FROM medications m2 WHERE m2.PATIENT = patient_summary.id AND m2.STOP IS NULL) AS active_medications,
                has_active_careplan
              FROM patient_summary
              ORDER BY ${orderBy} ${order === "asc" ? "ASC" : "DESC"}
              LIMIT ${limit}`;
            const res = await fetch("https://uic-hackathon-data.christian-7f4.workers.dev/query", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sql }),
            });
            return res.json() as object;
          },
        }),

        // ── Cost Analyst Agent tool ──

        runCostAnalysis: tool({
          description:
            "Run a full Cost Analyst deep-dive on a specific patient. " +
            "Fires parallel queries for costs, encounters, conditions, medications, procedures, " +
            "SDOH observations, care plans, and demographics. Returns a structured briefing with " +
            "cost summary, avoidable patterns (ED clustering, polypharmacy, substance use, missing care plan), " +
            "SDOH risks, and prioritized action items. Use for patient_specific intent.",
          inputSchema: z.object({
            patientName: z.string().describe("Patient name — partial is fine. Handles Synthea numeric suffixes automatically."),
          }),
          execute: async ({ patientName }) => {
            const DB = "https://uic-hackathon-data.christian-7f4.workers.dev/query";
            const query = async (sql: string) => {
              const r = await fetch(DB, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sql }),
              });
              const j = await r.json() as { results?: unknown[] };
              return j.results ?? [];
            };

            const nameParts = patientName.trim().split(/\s+/);
            const first = nameParts[0].replaceAll("'", "''");
            const last = nameParts[nameParts.length - 1].replaceAll("'", "''");
            const nameWhere = `LOWER(first) LIKE LOWER('%${first}%') AND LOWER(last) LIKE LOWER('%${last}%')`;

            const summaryRows = await query(
              `SELECT id, first, last, total_cost, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
               FROM patient_summary WHERE ${nameWhere} LIMIT 3`
            ) as Record<string, string>[];
            if (!summaryRows.length) return { error: `No patient found matching "${patientName}".` };

            const s = summaryRows[0];
            const pid = s.id.replaceAll("'", "''");
            const displayName = `${s.first} ${s.last}`;

            const [encounters, costByClass, topMeds, topProcs, conditions, observations, careplans, demographics] =
              await Promise.all([
                query(`SELECT ENCOUNTERCLASS, COUNT(*) as cnt FROM encounters WHERE PATIENT = '${pid}' GROUP BY ENCOUNTERCLASS ORDER BY cnt DESC LIMIT 10`),
                query(`SELECT ENCOUNTERCLASS, ROUND(SUM(AMOUNT),2) as total, COUNT(*) as claims FROM claims_transactions WHERE PATIENTID = '${pid}' GROUP BY ENCOUNTERCLASS ORDER BY total DESC LIMIT 8`),
                query(`SELECT DESCRIPTION, ROUND(TOTALCOST,2) as cost, STOP FROM medications WHERE PATIENT = '${pid}' AND TOTALCOST > 0 ORDER BY TOTALCOST DESC LIMIT 10`),
                query(`SELECT DESCRIPTION, ROUND(BASE_COST,2) as cost, CODE FROM procedures WHERE PATIENT = '${pid}' AND BASE_COST > 0 ORDER BY BASE_COST DESC LIMIT 10`),
                query(`SELECT DESCRIPTION, START, STOP FROM conditions WHERE PATIENT = '${pid}' ORDER BY START DESC LIMIT 30`),
                query(`SELECT DESCRIPTION, VALUE FROM observations WHERE PATIENT = '${pid}' AND (LOWER(DESCRIPTION) LIKE '%housing%' OR LOWER(DESCRIPTION) LIKE '%food%' OR LOWER(DESCRIPTION) LIKE '%transport%' OR LOWER(DESCRIPTION) LIKE '%stress%' OR LOWER(DESCRIPTION) LIKE '%social%') LIMIT 20`),
                query(`SELECT DESCRIPTION, START, STOP FROM careplans WHERE PATIENT = '${pid}' ORDER BY START DESC LIMIT 10`),
                query(`SELECT INCOME, RACE, ETHNICITY, CITY, STATE, GENDER, BIRTHDATE, HEALTHCARE_EXPENSES FROM patients WHERE Id = '${pid}' LIMIT 1`),
              ]);

            const demo = (demographics as Record<string, string>[])[0] ?? {};
            const activeCareplan = (careplans as Record<string, string>[]).some(cp => !cp.STOP);
            const activeMeds = (topMeds as Record<string, string>[]).filter(m => !m.STOP);
            const activeConditions = (conditions as Record<string, string>[]).filter(c => !c.STOP);
            const edVisits = parseInt(s.ed_visits) || 0;
            const inpatientVisits = parseInt(s.inpatient_visits) || 0;
            const totalCost = parseFloat(s.total_cost) || 0;
            const edInpatientCost = parseFloat(s.ed_inpatient_total_cost) || 0;
            const edInpatientPct = totalCost > 0 ? ((edInpatientCost / totalCost) * 100).toFixed(1) : "0";

            const flags: { severity: string; category: string; finding: string; action: string }[] = [];
            if (edVisits >= 5) flags.push({ severity: edVisits >= 10 ? "URGENT" : "HIGH", category: "High ED Utilization", finding: `${edVisits} total ED visits`, action: "Enroll in ED diversion program; establish primary care with same-day access" });
            if (inpatientVisits >= 10) flags.push({ severity: "HIGH", category: "High Inpatient Utilization", finding: `${inpatientVisits} inpatient stays`, action: "Complex care management; assess readmission risk" });
            const substanceConditions = activeConditions.filter(c => /drug|abuse|substance|opioid|alcohol|overdose/i.test(c.DESCRIPTION));
            if (substanceConditions.length) flags.push({ severity: "URGENT", category: "Substance Use Disorder", finding: substanceConditions.slice(0,3).map(c => c.DESCRIPTION).join("; "), action: "Refer to addiction medicine + behavioral health; evaluate for MAT" });
            const painConditions = activeConditions.filter(c => /pain/i.test(c.DESCRIPTION));
            const hasPainPlan = (careplans as Record<string, string>[]).some(cp => /pain/i.test(cp.DESCRIPTION));
            if (painConditions.length && !hasPainPlan) flags.push({ severity: "HIGH", category: "Chronic Pain Without Care Plan", finding: `${painConditions.length} pain condition(s), no pain management plan`, action: "Develop multimodal pain plan; consider pain specialist referral" });
            if (activeMeds.length > 15) flags.push({ severity: "HIGH", category: "Polypharmacy Risk", finding: `${activeMeds.length} active medications`, action: "Pharmacist medication review; simplify regimen; assess adherence" });
            if (!activeCareplan && totalCost > 500000) flags.push({ severity: "URGENT", category: "No Active Care Plan (High Cost)", finding: `$${totalCost.toLocaleString()} total cost with no active care plan`, action: "URGENT: Establish comprehensive care plan within 1 week" });

            const sdohRisks: { factor: string; value: string; action: string }[] = [];
            if (demo.INCOME && parseFloat(demo.INCOME) < 20000) sdohRisks.push({ factor: "Low Income", value: `$${parseFloat(demo.INCOME).toLocaleString()}`, action: "Screen for Medicaid, food assistance, prescription support programs" });
            const obs = observations as Record<string, string>[];
            if (obs.some(o => /transport/i.test(o.DESCRIPTION))) sdohRisks.push({ factor: "Transportation Barrier", value: "Documented", action: "Arrange NEMT; offer telehealth; community driver programs" });
            if (obs.some(o => /housing/i.test(o.DESCRIPTION)) || activeConditions.some(c => /housing|homeless/i.test(c.DESCRIPTION))) sdohRisks.push({ factor: "Housing Instability", value: "Documented", action: "Housing navigation; emergency shelter referral; coordinate social services" });
            if (obs.some(o => /food/i.test(o.DESCRIPTION))) sdohRisks.push({ factor: "Food Insecurity", value: "Documented", action: "Connect to SNAP, food pantry, community nutrition programs" });
            if (obs.some(o => /stress/i.test(o.DESCRIPTION))) sdohRisks.push({ factor: "Stress / Mental Health", value: "Documented", action: "Behavioral health referral; peer support; care coordination" });

            return {
              patient: { id: pid, name: displayName, demographics: { gender: demo.GENDER, dob: demo.BIRTHDATE, city: demo.CITY, state: demo.STATE, income: demo.INCOME, race: demo.RACE } },
              costSummary: { totalCost: `$${totalCost.toLocaleString()}`, edInpatientCost: `$${edInpatientCost.toLocaleString()}`, edInpatientPct: `${edInpatientPct}%`, edVisits, inpatientVisits, chronicConditions: parseInt(s.chronic_condition_count) || 0, hasActiveCareplan: activeCareplan },
              costByEncounterClass: costByClass,
              topCostMedications: topMeds.slice(0, 5),
              topCostProcedures: topProcs.slice(0, 5),
              activeConditionCount: activeConditions.length,
              activeMedicationCount: activeMeds.length,
              avoidablePatterns: flags,
              sdohRisks,
              priorityLevel: flags.some(f => f.severity === "URGENT") ? "URGENT" : flags.some(f => f.severity === "HIGH") ? "HIGH" : "MEDIUM",
              suggestedActions: [
                ...flags.map(f => `[${f.severity}] ${f.category}: ${f.action}`),
                ...sdohRisks.map(r => `[SDOH] ${r.factor}: ${r.action}`),
              ],
            };
          },
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
      stopWhen: stepCountIs(10),
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
