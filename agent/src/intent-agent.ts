import { z } from "zod";

/**
 * Intent classification for routing user queries to specialized agents
 */
export type Intent = 
  | "portfolio_analysis"      // Questions about patient population, costs, trends
  | "patient_specific"        // Questions about a named/specific patient
  | "patient_search"          // Finding patients by criteria
  | "clarification";          // User needs to clarify their question

/**
 * Structured intent detection result
 */
export interface IntentResult {
  intent: Intent;
  confidence: number;           // 0-1 confidence score
  patientIdentifier?: string;   // e.g. patient name or ID if mentioned
  query: string;                // Original user query
  reasoning: string;            // Why we classified it this way
  suggestedFollowUp?: string;   // If clarification needed
}

/**
 * Intent Agent: Classifies user queries and routes to specialized sub-agents
 * 
 * Portfolio questions: "Who are my most expensive patients?" "What's our ED utilization?"
 * Patient-specific: "Tell me about Giovanni Paucek's costs" "Why is this patient expensive?"
 * Patient search: "Find patients with >10 ED visits" "Show me diabetics without care plans"
 * Clarification: "What do you mean?" or ambiguous queries
 */
export class IntentAgent {
  /**
   * Parse user query and classify intent
   */
  static classifyIntent(userQuery: string): IntentResult {
    const lowerQuery = userQuery.toLowerCase().trim();

    // Pattern 1: Portfolio/population queries
    const portfolioPatterns = [
      // "top N" or "most expensive" ranking queries — most common real-world phrasing
      /top\s+\d+/i,
      /most expensive/i,
      /highest cost/i,
      /lowest cost/i,
      /most (?:ed|emergency|inpatient|hospital)/i,
      /expensive patients/i,
      /costly patients/i,
      /rank(?:ed)? (?:by|patients)/i,
      // Population/portfolio keywords
      /^who are (?:my|the)/i,
      /^what(?:'s| is) (?:our|the) (?:ed|emergency) utilization/i,
      /^show me.*(?:top|highest|most expensive)/i,
      /^list (?:the )?(?:most|top|highest)/i,
      /^how many patients/i,
      /^what (?:conditions|diagnoses) are most common/i,
      /^analyze (?:my|the) patient population/i,
      /portfolio|population|cohort/i,
      // Time-bounded ranking queries ("last 3 months", "this year", etc.)
      /(?:last|past|recent)\s+\d+\s+(?:days?|weeks?|months?|years?)/i,
      /this (?:week|month|quarter|year)/i,
    ];

    // Pattern 2: Check portfolio FIRST — catches "top 5 expensive patients in last 3 months" etc.
    for (const pattern of portfolioPatterns) {
      if (pattern.test(lowerQuery)) {
        return {
          intent: "portfolio_analysis",
          confidence: 0.9,
          query: userQuery,
          reasoning: "Query asks for ranked/population-level results. Routing to Patient Finder Agent.",
        };
      }
    }

    // Pattern 3: Patient search queries
    const searchPatterns = [
      /(?:find|search|show|list|get).*patients/i,
      /which patients (?:have|with|without)/i,
      /patients (?:with|without)/i,
      /ed visits|inpatient|polypharmacy/i,
    ];

    for (const pattern of searchPatterns) {
      if (pattern.test(lowerQuery)) {
        return {
          intent: "patient_search",
          confidence: 0.85,
          query: userQuery,
          reasoning: "Query searches for patients with specific criteria. Will filter and present results.",
        };
      }
    }

    // Pattern 3: Patient-specific queries (mentions a patient name or "this patient")
    const patientSpecificPatterns = [
      /(?:tell|show|what|why|analyze|explain).*(?:about|for|on)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
      /^patient[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
      /^([A-Z][a-z]+\s+[A-Z][a-z]+)['\s]?s/i,
      /why is\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
      /this patient['\s]?s/i,
      /what conditions does/i,
    ];

    // Check for patient-specific mentions (extract name)
    let patientMatch = null;
    for (const pattern of patientSpecificPatterns) {
      const match = lowerQuery.match(pattern);
      if (match && match[1]) {
        patientMatch = match[1];
        break;
      }
    }

    // If we found a patient name and it's clearly about that patient
    if (patientMatch) {
      return {
        intent: "patient_specific",
        confidence: 0.95,
        patientIdentifier: patientMatch,
        query: userQuery,
        reasoning: `Detected patient-specific query mentioning "${patientMatch}". Will route to Cost Analyst Agent for deep dive.`,
      };
    }

    // If we got here, default to portfolio — better to show data than ask an unnecessary question
    return {
      intent: "clarification",
      confidence: 0.5,
      query: userQuery,
      reasoning: "Query is ambiguous or doesn't clearly fit portfolio, patient-specific, or search patterns.",
      suggestedFollowUp: 'Are you asking about a specific patient (e.g., "Tell me about Giovanni Paucek"), your whole patient population (e.g., "Who are my most expensive patients?"), or searching for patients with specific criteria?',
    };
  }

  /**
   * Format intent classification into a user-facing response
   */
  static formatIntentResponse(result: IntentResult): string {
    switch (result.intent) {
      case "portfolio_analysis":
        return `📊 **Portfolio Analysis**\nI'll analyze your patient population and identify cost trends.\n${result.reasoning}`;
      
      case "patient_specific":
        return `👤 **Patient Deep Dive**\nFocusing on ${result.patientIdentifier}. I'll drill into their cost drivers, encounter history, and care patterns.\n${result.reasoning}`;
      
      case "patient_search":
        return `🔍 **Patient Search**\nSearching your population for matching criteria...\n${result.reasoning}`;
      
      case "clarification":
        return `❓ **Need Clarification**\n${result.suggestedFollowUp}`;
      
      default:
        return `Detected intent: ${result.intent}`;
    }
  }

  /**
   * Generate SQL routing hint based on intent
   */
  static getSQLHint(result: IntentResult): string {
    switch (result.intent) {
      case "portfolio_analysis":
        return "SELECT first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, total_cost, has_active_careplan FROM patient_summary ORDER BY ed_inpatient_total_cost DESC LIMIT 15";
      
      case "patient_specific":
        if (result.patientIdentifier) {
          const nameParts = result.patientIdentifier.split(/\s+/);
          return `SELECT * FROM patient_summary WHERE LOWER(first) LIKE LOWER('%${nameParts[0]}%') AND LOWER(last) LIKE LOWER('%${nameParts[nameParts.length - 1]}%') LIMIT 5`;
        }
        return "SELECT * FROM patient_summary LIMIT 1";
      
      case "patient_search":
        return "SELECT first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count FROM patient_summary WHERE ed_visits > 5 OR inpatient_visits > 10 LIMIT 20";
      
      default:
        return "SELECT COUNT(*) as patient_count FROM patient_summary";
    }
  }
}

/**
 * Schema for the Intent Agent tool
 */
export const intentClassificationSchema = z.object({
  userQuery: z.string().describe("The user's natural language question or request"),
});

/**
 * Create an intent classification tool for use in the main agent
 */
export function createIntentClassificationTool() {
  return {
    description:
      "Classify the user's intent and route to appropriate sub-agent. " +
      "Understands portfolio questions (population-level), patient-specific queries, and search requests.",
    inputSchema: intentClassificationSchema,
    execute: async ({ userQuery }: { userQuery: string }) => {
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
  };
}
