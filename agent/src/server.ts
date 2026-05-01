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
  const substanceConds = activeConditions.filter(c => /drug|abuse|substance|opioid|alcohol|overdose/i.test(c.DESCRIPTION));

  // SDOH flags
  const sdohFlags: string[] = [];
  if (demo.INCOME && parseFloat(demo.INCOME) < 20000) sdohFlags.push("Low Income ($" + parseFloat(demo.INCOME).toLocaleString() + "/yr)");
  if (observations.some(o => /transport/i.test(o.DESCRIPTION))) sdohFlags.push("Transportation Barrier");
  if (observations.some(o => /housing/i.test(o.DESCRIPTION)) || activeConditions.some(c => /housing|homeless/i.test(c.DESCRIPTION))) sdohFlags.push("Housing Instability");
  if (observations.some(o => /food/i.test(o.DESCRIPTION))) sdohFlags.push("Food Insecurity");

  // ── Table 1: Pain Points ──────────────────────────────────────────────
  type PainPoint = { painPoint: string; metric: string; explanation: string };
  const painPoints: PainPoint[] = [];

  if (edVisits > 0) painPoints.push({
    painPoint: "Frequent Emergency Room Visits",
    metric: `${edVisits} ED visits (${edInpatientPct}% of total spend is acute care)`,
    explanation: `At $1,500–$3,000 per visit, ED overuse is one of the most preventable cost drivers. Most of these visits could be handled by primary care if the patient had reliable access.`
  });
  if (inpatientVisits > 0) painPoints.push({
    painPoint: "Repeated Hospitalizations",
    metric: `${inpatientVisits} inpatient stays`,
    explanation: `Hospital admissions are the single largest cost driver. Each stay averages $10,000–$30,000. Without a proactive care plan, readmissions are highly likely.`
  });
  if (substanceConds.length) painPoints.push({
    painPoint: "Substance Use Disorder",
    metric: `Active diagnosis: ${substanceConds[0].DESCRIPTION}`,
    explanation: `SUD drives repeated crisis visits and emergency admissions. It also makes every chronic condition harder to manage, creating a compounding cost cycle.`
  });
  if (parseInt(s.chronic_condition_count) > 10) painPoints.push({
    painPoint: "High Chronic Condition Burden",
    metric: `${s.chronic_condition_count} active chronic conditions`,
    explanation: `Each condition requires its own specialist, medications, and monitoring. Managing this many simultaneously creates care fragmentation and high avoidable spend.`
  });
  if (!activeCareplan) painPoints.push({
    painPoint: "No Active Care Plan",
    metric: `Care plan: Missing`,
    explanation: `Without a coordinated care plan, this patient's care is entirely reactive. Every health crisis becomes an ED visit or hospitalization instead of a managed outpatient encounter.`
  });
  if (activeMeds.length > 10) painPoints.push({
    painPoint: "Polypharmacy Risk",
    metric: `${activeMeds.length} active medications`,
    explanation: `This many medications significantly raises the risk of drug interactions, non-adherence, and adverse events — each of which can trigger an avoidable hospitalization.`
  });
  if (sdohFlags.length) painPoints.push({
    painPoint: "Social Barriers to Care",
    metric: sdohFlags.join(", "),
    explanation: `Social determinants like transportation, housing, and food security directly impact whether this patient can attend appointments, fill prescriptions, or follow a care plan.`
  });

  const painTable = painPoints.slice(0, 6).map((p, i) =>
    `| ${i+1} | ${p.painPoint} | ${p.metric} | ${p.explanation} |`
  ).join("\n") || `| 1 | Insufficient data | — | Could not retrieve full clinical record |`;

  // ── Table 2: Recommendations sorted by priority ───────────────────────
  type Action = { priority: "URGENT" | "HIGH" | "MEDIUM"; action: string; owner: string; when: string };
  const actions: Action[] = [];

  if (substanceConds.length) actions.push({ priority: "URGENT", action: "Refer to addiction medicine and behavioral health. Evaluate for Medication-Assisted Treatment (MAT) such as buprenorphine.", owner: "Care Manager + Clinician", when: "Within 24–48 hours" });
  if (!activeCareplan && totalCost > 200000) actions.push({ priority: "URGENT", action: "Establish a comprehensive care plan. This patient has no care plan and is one of the highest-cost patients in the population.", owner: "Care Team", when: "Within 24–48 hours" });
  if (edVisits >= 5) actions.push({ priority: edVisits >= 10 ? "URGENT" : "HIGH", action: "Enroll in ED diversion program. Establish same-day primary care access so health crises are handled before they escalate to the ER.", owner: "Care Manager", when: "Within 1 week" });
  if (inpatientVisits >= 10) actions.push({ priority: "HIGH", action: "Assign to complex care management track. Conduct post-discharge follow-up within 48 hours to prevent readmissions.", owner: "Care Manager", when: "Within 1 week" });
  if (activeMeds.length > 15) actions.push({ priority: "HIGH", action: "Conduct pharmacist-led medication reconciliation. Simplify the regimen and assess for drug interactions and non-adherence.", owner: "Pharmacist", when: "Within 1 week" });
  if (sdohFlags.includes("Transportation Barrier")) actions.push({ priority: "MEDIUM", action: "Arrange non-emergency medical transportation (NEMT). Offer telehealth for follow-up visits to remove access barriers.", owner: "Social Worker", when: "Within 2 weeks" });
  if (sdohFlags.includes("Housing Instability")) actions.push({ priority: "MEDIUM", action: "Connect to housing navigation services. Coordinate with local shelter and social services to stabilize the patient's living situation.", owner: "Social Worker", when: "Within 2 weeks" });
  if (sdohFlags.includes("Food Insecurity")) actions.push({ priority: "MEDIUM", action: "Enroll in SNAP and connect to local food pantry or community nutrition programs.", owner: "Social Worker", when: "Within 2 weeks" });
  if (!activeCareplan) actions.push({ priority: "MEDIUM", action: "Schedule a comprehensive care assessment to identify all active conditions, care gaps, and medication needs.", owner: "Care Manager", when: "Within 2 weeks" });

  // Sort: URGENT → HIGH → MEDIUM
  const priorityOrder = { "URGENT": 0, "HIGH": 1, "MEDIUM": 2 };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const actTable = actions.slice(0, 6).map(a =>
    `| ${a.priority} | ${a.action} | ${a.owner} | ${a.when} |`
  ).join("\n") || `| MEDIUM | Schedule comprehensive patient assessment | Care Manager | Within 1 week |`;

  return `## Patient Cost Analysis: ${displayName}
**Total Cost:** $${totalCost.toLocaleString()} | **ED + Inpatient:** $${edInpatientCost.toLocaleString()} (${edInpatientPct}% of total) | **Active Conditions:** ${s.chronic_condition_count} | **Care Plan:** ${activeCareplan ? "Active" : "None"}

---

### 🔴 Why This Patient's Costs Are High

| # | Pain Point | Key Metrics | Explanation |
|---|---|---|---|
${painTable}

---

### ✅ Recommendations for Care Manager (sorted by priority)

| Priority | Recommended Action | Owner | Timeline |
|---|---|---|---|
${actTable}

---
*Want me to draft an outreach message or full care plan for ${displayName}?*`;
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

    // ── Step 3: If we have pre-fetched data, stream it directly ──────────
    // Build SSE in the exact format AIChatAgent._streamSSEReply parses:
    // text-start → text-delta → text-end, then finish chunks.
    if (agentData) {
      const msgId = crypto.randomUUID();
      const lines = [
        `data: ${JSON.stringify({ type: "text-start", id: msgId })}\n\n`,
        `data: ${JSON.stringify({ type: "text-delta", id: msgId, delta: agentData })}\n\n`,
        `data: ${JSON.stringify({ type: "text-end", id: msgId })}\n\n`,
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n\n`,
      ];
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-vercel-ai-ui-message-stream": "v1",
          "x-accel-buffering": "no",
        }
      });
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
