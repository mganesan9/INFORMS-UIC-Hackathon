"""
Patient Finder Agent (for Cost Explainer architecture)

Purpose:
- Resolve a care manager's patient reference (name or ID) to exact patient IDs.
- Handle portfolio lookup requests like "who are my most expensive patients?"
- Return a structured response that an orchestrator/intent agent can route onward.

Run:
  cd Workshop
  source .venv/bin/activate
  python patient_finder_agent.py
"""

import asyncio
import tempfile
import requests
from typing import Any

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    tool,
    create_sdk_mcp_server,
    AssistantMessage,
    UserMessage,
    TextBlock,
    ToolUseBlock,
)


DIM = "\033[2m"
CYAN = "\033[36m"
RESET = "\033[0m"

D1 = "https://uic-hackathon-data.christian-7f4.workers.dev/query"


SYSTEM = """You are the Patient Finder Agent for a healthcare Cost Explainer workflow.

Your only job is patient resolution and shortlist generation.

You must classify each request into one of:
1) PATIENT_QUERY: the user is asking about a specific patient (name or ID)
2) PORTFOLIO_QUERY: the user asks population/portfolio questions like "most expensive patients"
3) NEEDS_CLARIFICATION: ambiguous patient reference with multiple close matches

Rules:
- Always use tools for patient lookups.
- Names in this dataset often include numeric suffixes (example: Lindsay928 Brekke496).
- If a specific patient is requested and one clear match exists, return that patient's ID.
- If multiple plausible matches exist, ask a concise clarification question.
- Do NOT do deep cost analysis here. That belongs to downstream agents.

Final response format (exact headings):
STATUS: <PATIENT_QUERY|PORTFOLIO_QUERY|NEEDS_CLARIFICATION>
SELECTED_PATIENT_ID: <id or null>
SHORTLIST:
- <id> | <first last> | cost=<ed_inpatient_total_cost> | visits=<total_visits>
NEXT_STEP_HINT: <one-line handoff guidance for orchestrator>
"""


def _escape_sql(value: str) -> str:
    return value.replace("'", "''")


@tool(
    "find_patient_candidates",
    "Find candidate patients by fuzzy name or exact ID.",
    {"query": str, "limit": int},
)
async def find_patient_candidates(args: dict[str, Any]) -> dict[str, Any]:
    query = _escape_sql(args["query"].strip().lower())
    limit = max(1, min(int(args.get("limit", 8)), 20))

    sql = f"""
    SELECT
      id,
      first,
      last,
      ed_inpatient_total_cost,
      total_visits,
      has_active_careplan
    FROM patient_summary
    WHERE
      LOWER(id) = '{query}'
      OR LOWER(first || ' ' || last) LIKE '%{query}%'
      OR LOWER(first) LIKE '%{query}%'
      OR LOWER(last) LIKE '%{query}%'
    ORDER BY
      CASE
        WHEN LOWER(id) = '{query}' THEN 0
        WHEN LOWER(first || ' ' || last) = '{query}' THEN 1
        WHEN LOWER(first) = '{query}' OR LOWER(last) = '{query}' THEN 2
        ELSE 3
      END,
      ed_inpatient_total_cost DESC
    LIMIT {limit}
    """

    result = requests.post(D1, json={"sql": sql}, timeout=15).json()
    return {"content": [{"type": "text", "text": str(result)}]}


@tool(
    "list_expensive_patients",
    "Return top patients by ED + inpatient spend for portfolio-level requests.",
    {"limit": int},
)
async def list_expensive_patients(args: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(args.get("limit", 10)), 25))
    sql = f"""
    SELECT
      id,
      first,
      last,
      ed_inpatient_total_cost,
      total_visits,
      ed_visits,
      inpatient_visits,
      has_active_careplan
    FROM patient_summary
    ORDER BY ed_inpatient_total_cost DESC
    LIMIT {limit}
    """
    result = requests.post(D1, json={"sql": sql}, timeout=15).json()
    return {"content": [{"type": "text", "text": str(result)}]}


async def main():
    finder = create_sdk_mcp_server(
        name="finder",
        version="1.0.0",
        tools=[find_patient_candidates, list_expensive_patients],
    )

    with tempfile.TemporaryDirectory() as cwd:
        options = ClaudeAgentOptions(
            system_prompt=SYSTEM,
            cwd=cwd,
            mcp_servers={"finder": finder},
            allowed_tools=[
                "mcp__finder__find_patient_candidates",
                "mcp__finder__list_expensive_patients",
            ],
            disallowed_tools=[
                "Bash",
                "BashOutput",
                "Read",
                "Write",
                "Edit",
                "Glob",
                "Grep",
                "WebFetch",
                "WebSearch",
                "Task",
                "TodoWrite",
                "NotebookEdit",
                "KillShell",
                "SlashCommand",
            ],
        )

        async with ClaudeSDKClient(options=options) as client:
            print("─" * 64)
            print("PATIENT FINDER AGENT")
            print("Resolve patient references + shortlist expensive candidates.")
            print("Type 'exit' to quit.")
            print("─" * 64)

            while True:
                try:
                    user_input = input("\n💬 Care manager query › ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break

                if not user_input or user_input.lower() in ("exit", "quit"):
                    break

                await client.query(user_input)
                print("\n🤖 Patient Finder ›\n")

                async for message in client.receive_response():
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, ToolUseBlock) and block.name.startswith("mcp__"):
                                short = block.name.split("__")[-1]
                                print(f"{CYAN}🔧 {short}({block.input}){RESET}", flush=True)
                            elif isinstance(block, TextBlock):
                                print(block.text, end="", flush=True)
                    elif isinstance(message, UserMessage):
                        for block in message.content:
                            content = getattr(block, "content", None)
                            if isinstance(content, list):
                                for item in content:
                                    text = item.get("text", "") if isinstance(item, dict) else ""
                                    if "'count':" in text:
                                        try:
                                            count = text.split("'count':")[1].split(",")[0].strip()
                                            print(f"{DIM}   ← {count} rows{RESET}", flush=True)
                                        except (IndexError, ValueError):
                                            pass

                print()


if __name__ == "__main__":
    asyncio.run(main())
