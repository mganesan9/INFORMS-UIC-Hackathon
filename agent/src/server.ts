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

const DB = "https://uic-hackathon-data.christian-7f4.workers.dev/query";

async function dbQuery(sql: string): Promise<Record<string, string>[]> {
  const r = await fetch(DB, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json() as { results?: Record<string, string>[] };
  return j.results ?? [];
}

// ── Patient Finder Agent ──────────────────────────────────────────────────
// Fetches ranked patient portfolio data and returns it as a formatted string
// for the model to present in natural language.
async function patientFinderAgent(query: string): Promise<string> {
  const lower = query.toLowerCase();

  // Determine ranking metric from the query
  let orderBy = "ed_inpatient_total_cost";
  let metricLabel = "ED + Inpatient Cost";
  if (/ed visit|emergency visit/.test(lower)) { orderBy = "ed_visits"; metricLabel = "ED Visits"; }
  else if (/inpatient|hospital/.test(lower)) { orderBy = "inpatient_visits"; metricLabel = "Hospitalizations"; }
  else if (/condition|chronic/.test(lower)) { orderBy = "chronic_condition_count"; metricLabel = "Chronic Conditions"; }

  const limitMatch = query.match(/\b(\d+)\b/);
  const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 25) : 10;
  const order = /least|lowest|cheapest|fewest/.test(lower) ? "ASC" : "DESC";

  const rows = await dbQuery(`
    SELECT first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits,
      chronic_condition_count, has_active_careplan, total_cost
    FROM patient_summary
    ORDER BY ${orderBy} ${order}
    LIMIT ${limit}
  `);

  if (!rows.length) return "No patients found.";

  const tableRows = rows.map((r, i) => {
    const name = `${r.first} ${r.last}`;
    const cost = `$${parseFloat(r.ed_inpatient_total_cost).toLocaleString()}`;
    const ed = r.ed_visits;
    const ip = r.inpatient_visits;
    const cond = r.chronic_condition_count;
    const cp = r.has_active_careplan === "1" ? "Yes" : "**No**";
    return `| ${i+1} | ${name} | ${cost} | ${ed} | ${ip} | ${cond} | ${cp} |`;
  }).join("\n");

  return `Here are the top ${rows.length} patients ranked by ${metricLabel}:

| # | Patient Name | ED+Inpatient Cost | ED Visits | Hospitalizations | Active Conditions | Care Plan |
|---|---|---|---|---|---|---|
${tableRows}

Want a full cost analysis on any of these patients? Just ask: "Tell me about [name]"`;
}

// ── Cost Analyst Agent ────────────────────────────────────────────────────
// Runs 8 parallel DB queries for a specific patient and returns pre-built
// markdown so the model can present it without needing to call any tools.
async function costAnalystAgent(patientName: string): Promise<string> {
  const nameParts = patientName.trim().split(/\s+/);
  const first = nameParts[0].replaceAll("'", "''");
  const last = nameParts[nameParts.length - 1].replaceAll("'", "''");
  const nameWhere = `LOWER(first) LIKE LOWER('%${first}%') AND LOWER(last) LIKE LOWER('%${last}%')`;

  const summaryRows = await dbQuery(
    `SELECT id, first, last, total_cost, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
     FROM patient_summary WHERE ${nameWhere} LIMIT 3`
  );
  if (!summaryRows.length) return `No patient found matching "${patientName}". Try a partial name like "Giovanni" or "Lindsay".`;

  const s = summaryRows[0];
  const pid = s.id.replaceAll("'", "''");
  const displayName = `${s.first} ${s.last}`;

  const [encounters, costByClass, topMeds, topProcs, conditions, observations, careplans, demographics] =
    await Promise.all([
      dbQuery(`SELECT ENCOUNTERCLASS, COUNT(*) as cnt FROM encounters WHERE PATIENT = '${pid}' GROUP BY ENCOUNTERCLASS ORDER BY cnt DESC LIMIT 10`),
      dbQuery(`SELECT ENCOUNTERCLASS, ROUND(SUM(AMOUNT),2) as total, COUNT(*) as claims FROM claims_transactions WHERE PATIENTID = '${pid}' GROUP BY ENCOUNTERCLASS ORDER BY total DESC LIMIT 8`),
      dbQuery(`SELECT DESCRIPTION, ROUND(TOTALCOST,2) as cost, STOP FROM medications WHERE PATIENT = '${pid}' AND TOTALCOST > 0 ORDER BY TOTALCOST DESC LIMIT 10`),
      dbQuery(`SELECT DESCRIPTION, ROUND(BASE_COST,2) as cost, CODE FROM procedures WHERE PATIENT = '${pid}' AND BASE_COST > 0 ORDER BY BASE_COST DESC LIMIT 10`),
      dbQuery(`SELECT DESCRIPTION, START, STOP FROM conditions WHERE PATIENT = '${pid}' ORDER BY START DESC LIMIT 30`),
      dbQuery(`SELECT DESCRIPTION, VALUE FROM observations WHERE PATIENT = '${pid}' AND (LOWER(DESCRIPTION) LIKE '%housing%' OR LOWER(DESCRIPTION) LIKE '%food%' OR LOWER(DESCRIPTION) LIKE '%transport%' OR LOWER(DESCRIPTION) LIKE '%stress%' OR LOWER(DESCRIPTION) LIKE '%social%') LIMIT 20`),
      dbQuery(`SELECT DESCRIPTION, START, STOP FROM careplans WHERE PATIENT = '${pid}' ORDER BY START DESC LIMIT 10`),
      dbQuery(`SELECT INCOME, RACE, ETHNICITY, CITY, STATE, GENDER, BIRTHDATE, HEALTHCARE_EXPENSES FROM patients WHERE Id = '${pid}' LIMIT 1`),
    ]);

  const demo = demographics[0] ?? {};
  const activeCareplan = careplans.some(cp => !cp.STOP);
  const activeMeds = topMeds.filter(m => !m.STOP);
  const activeConditions = conditions.filter(c => !c.STOP);
  const edVisits = parseInt(s.ed_visits) || 0;
  const inpatientVisits = parseInt(s.inpatient_visits) || 0;
  const totalCost = parseFloat(s.total_cost) || 0;
  const edInpatientCost = parseFloat(s.ed_inpatient_total_cost) || 0;
  const edInpatientPct = totalCost > 0 ? ((edInpatientCost / totalCost) * 100).toFixed(1) : "0";

  // WHY table
  const whyRows: string[] = [];
  if (edVisits > 0) whyRows.push(`| ${whyRows.length+1} | Emergency Room Overuse | ${edVisits} ED visits | Each visit costs $1,500–$3,000; primary care could handle most of these |`);
  if (inpatientVisits > 0) whyRows.push(`| ${whyRows.length+1} | Frequent Hospitalizations | ${inpatientVisits} inpatient stays | Single biggest cost driver in high-cost patients |`);
  const substanceConds = activeConditions.filter(c => /drug|abuse|substance|opioid|alcohol|overdose/i.test(c.DESCRIPTION));
  if (substanceConds.length) whyRows.push(`| ${whyRows.length+1} | Substance Use Disorder | ${substanceConds[0].DESCRIPTION} | Drives repeated crisis visits; complicates every other condition |`);
  if (parseInt(s.chronic_condition_count) > 10) whyRows.push(`| ${whyRows.length+1} | Multiple Chronic Conditions | ${s.chronic_condition_count} active conditions | Increases specialist visits, meds, and hospitalizations |`);
  if (!activeCareplan) whyRows.push(`| ${whyRows.length+1} | No Active Care Plan | Missing | Without a plan, care is reactive (ED) instead of proactive |`);
  if (activeMeds.length > 10) whyRows.push(`| ${whyRows.length+1} | Polypharmacy | ${activeMeds.length} active medications | Raises risk of adverse events and avoidable admissions |`);
  if (parseFloat(edInpatientPct) > 70) whyRows.push(`| ${whyRows.length+1} | Cost Concentrated in Acute Care | ${edInpatientPct}% of spend is ED + inpatient | Almost nothing going to prevention or management |`);
  const sdohFlags: string[] = [];
  if (demo.INCOME && parseFloat(demo.INCOME) < 20000) sdohFlags.push("Low Income");
  if (observations.some(o => /transport/i.test(o.DESCRIPTION))) sdohFlags.push("Transportation Barrier");
  if (observations.some(o => /housing/i.test(o.DESCRIPTION)) || activeConditions.some(c => /housing|homeless/i.test(c.DESCRIPTION))) sdohFlags.push("Housing Instability");
  if (observations.some(o => /food/i.test(o.DESCRIPTION))) sdohFlags.push("Food Insecurity");
  if (sdohFlags.length) whyRows.push(`| ${whyRows.length+1} | Social Determinants of Health | ${sdohFlags.join(", ")} | Social barriers make it hard to follow care plans and keep appointments |`);
  const whyTable = whyRows.slice(0, 5).join("\n") || `| 1 | Insufficient data | Could not retrieve full record | — |`;

  // WHAT TO DO table
  const actionRows: string[] = [];
  if (edVisits >= 5) actionRows.push(`| ${edVisits >= 10 ? "URGENT" : "HIGH"} | Enroll in ED diversion program; establish primary care with same-day access | Care Manager | Within 1 week |`);
  if (inpatientVisits >= 10) actionRows.push(`| HIGH | Complex care management; assess readmission risk | Care Manager | Within 1 week |`);
  if (substanceConds.length) actionRows.push(`| URGENT | Refer to addiction medicine + behavioral health; evaluate for MAT | Care Manager + Clinician | Within 24–48 hours |`);
  if (!activeCareplan && totalCost > 500000) actionRows.push(`| URGENT | Establish comprehensive care plan immediately | Care Team | Within 24–48 hours |`);
  if (activeMeds.length > 15) actionRows.push(`| HIGH | Pharmacist medication review; simplify regimen | Pharmacist | Within 1 week |`);
  if (sdohFlags.includes("Transportation Barrier")) actionRows.push(`| MEDIUM | Arrange NEMT; offer telehealth visits | Social Worker | Within 2 weeks |`);
  if (sdohFlags.includes("Housing Instability")) actionRows.push(`| MEDIUM | Housing navigation referral; coordinate social services | Social Worker | Within 2 weeks |`);
  if (sdohFlags.includes("Food Insecurity")) actionRows.push(`| MEDIUM | Connect to SNAP, food pantry, community nutrition programs | Social Worker | Within 2 weeks |`);
  const actTable = actionRows.slice(0, 5).join("\n") || `| MEDIUM | Schedule comprehensive patient assessment | Care Manager | Within 1 week |`;

  return `**📋 Why ${displayName}'s Costs Are High**

| # | Cost Driver | Key Fact | Why It Matters |
|---|---|---|---|
${whyTable}

**✅ What the Care Manager Should Do**

| Priority | Action | Owner | When |
|---|---|---|---|
${actTable}

Want me to draft an outreach message or care plan for ${displayName}?`;
}

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

    // ── Step 1: Intent Agent — classify in TypeScript (no model needed) ──
    let lastUserText = "";
    try {
      const msgs = this.messages as Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          lastUserText = (msgs[i].parts ?? [])
            .filter(p => p.type === "text")
            .map(p => p.text ?? "")
            .join(" ")
            .trim();
          break;
        }
      }
    } catch { lastUserText = ""; }

    const intentResult = IntentAgent.classifyIntent(lastUserText);

    // ── Step 2: Run the appropriate sub-agent in code ─────────────────────
    let agentData = "";
    if (intentResult.intent === "portfolio_analysis") {
      agentData = await patientFinderAgent(lastUserText);
    } else if (intentResult.intent === "patient_specific" || intentResult.intent === "patient_search") {
      const name = intentResult.patientIdentifier ?? lastUserText;
      agentData = await costAnalystAgent(name);
    }

    // ── Step 3: If we have pre-fetched data, return it directly ───────────
    // The model is only used for clarification questions or follow-up prose.
    if (agentData) {
      const result = streamText({
        model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          sessionAffinity: this.sessionAffinity
        }),
        system: `You are a healthcare cost analytics assistant. The data agents have already fetched and formatted the answer below.
Your ONLY job: output the AGENT DATA exactly as-is, word for word, with no changes, no additions, no summary before or after it.
Do not say "Here is..." or "Based on..." — just output the data directly.

AGENT DATA:
${agentData}`,
        messages: pruneMessages({
          messages: inlineDataUrls(await convertToModelMessages(this.messages)),
          toolCalls: "before-last-2-messages"
        }),
        stopWhen: stepCountIs(1),
        abortSignal: options?.abortSignal
      });
      return result.toUIMessageStreamResponse();
    }

    // ── Step 4: Clarification — model answers freely ──────────────────────
    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a healthcare cost analytics assistant for a value-based care practice.
You help care managers understand patient costs and find high-risk patients.
If the user's question is unclear, ask them to clarify whether they want:
- A ranked list of patients (e.g. "top 10 most expensive patients")
- A deep dive on a specific patient (e.g. "tell me about Giovanni Paucek")
- To search for patients by criteria (e.g. "patients with no care plan")`,
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: { ...mcpTools },
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });
    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);
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
