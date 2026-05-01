#!/usr/bin/env python3
"""
Quick Start Examples for the Cost Analyst Agent

This script demonstrates how to use the cost analyst tools programmatically
to integrate into larger applications or workflows.
"""

from cost_analyst_agent import CostAnalystAgent
from care_manager_interface import CareManagerInterface
from batch_cost_analyst import BatchCostAnalyst


def example_1_single_patient_analysis():
    """Example 1: Analyze a single high-cost patient."""
    print("\n" + "=" * 80)
    print("EXAMPLE 1: Single Patient Analysis")
    print("=" * 80)
    
    patient_id = "9b2a3600-1c8a-52ec-6864-b45f6f6ce66c"  # Giovanni385 Paucek755
    
    agent = CostAnalystAgent()
    analysis = agent.analyze_patient(patient_id)
    
    print(f"\nPatient: {analysis['name']}")
    print(f"Total Cost: ${analysis['cost_summary']['total_cost']:,.2f}")
    print(f"ED/Inpatient Cost: ${analysis['cost_summary']['ed_inpatient_cost']:,.2f}")
    print(f"Chronic Conditions: {analysis['cost_summary']['chronic_conditions']}")
    print(f"\nNumber of Avoidable Patterns Detected: {len(analysis['avoidable_patterns'])}")
    for pattern in analysis['avoidable_patterns']:
        print(f"  • {pattern['category']} [{pattern['severity'].upper()}]")
    
    print(f"\nNumber of SDOH Barriers: {len(analysis['sdoh_risks'])}")
    for risk in analysis['sdoh_risks']:
        print(f"  • {risk['sdoh_factor']}")
    
    return analysis


def example_2_generate_briefing(analysis):
    """Example 2: Generate a plain-language briefing."""
    print("\n" + "=" * 80)
    print("EXAMPLE 2: Generate Plain-Language Briefing")
    print("=" * 80)
    
    agent = CostAnalystAgent()
    briefing = agent.generate_plain_language_briefing(analysis)
    
    # Print first 1500 characters
    print(briefing[:1500])
    print("\n... [briefing continues] ...\n")


def example_3_care_manager_plan(patient_id):
    """Example 3: Generate a structured care manager action plan."""
    print("\n" + "=" * 80)
    print("EXAMPLE 3: Care Manager Action Plan")
    print("=" * 80)
    
    interface = CareManagerInterface()
    action_plan = interface.generate_action_plan(patient_id)
    
    print(f"\nPatient: {action_plan['patient_name']}")
    print(f"Priority Level: {action_plan['priority_level'].upper()}")
    print(f"\nTotal Action Items: {len(action_plan['tasks'])}")
    
    urgent_tasks = [t for t in action_plan['tasks'] if t['priority'] == 'urgent']
    print(f"  - URGENT: {len(urgent_tasks)}")
    
    for task in urgent_tasks[:3]:
        print(f"\n  Task: {task['title']}")
        print(f"  Owner: {task['owner']}")
        print(f"  Due: {task['due_date'][:10]}")
    
    print(f"\nReferrals Needed: {len(action_plan['referrals'])}")
    for ref in action_plan['referrals'][:3]:
        print(f"  • {ref['specialty']} ({ref['urgency']})")
    
    return action_plan


def example_4_batch_analysis():
    """Example 4: Batch analysis of top 5 most expensive patients."""
    print("\n" + "=" * 80)
    print("EXAMPLE 4: Batch Analysis of Top Patients")
    print("=" * 80)
    
    batch = BatchCostAnalyst()
    top_patients = batch.get_top_cost_patients(n=5)
    
    print(f"\nTop 5 Most Expensive Patients:")
    for i, patient in enumerate(top_patients, 1):
        print(f"{i}. {patient['name']}: ${patient['total_cost']:,.2f}")
    
    # Analyze all
    print("\nRunning full analysis...")
    analyses = batch.analyze_top_patients(n=5, save_reports=False)
    
    print(f"Analysis complete for {len(analyses)} patients")
    
    # Generate executive summary
    summary = batch.generate_executive_summary(analyses)
    print("\nExecutive Summary (excerpt):")
    print(summary[:1000])
    print("\n... [summary continues] ...\n")
    
    return analyses


def example_5_programmatic_workflow():
    """Example 5: Programmatic workflow for integration."""
    print("\n" + "=" * 80)
    print("EXAMPLE 5: Programmatic Workflow")
    print("=" * 80)
    
    # Workflow: Find high-risk patients and generate care plans
    
    print("\nStep 1: Identify high-risk patients...")
    batch = BatchCostAnalyst()
    top_patients = batch.get_top_cost_patients(n=3)
    
    results = []
    for patient in top_patients:
        print(f"\n  Processing {patient['name']}...")
        
        # Step 2: Analyze costs
        agent = CostAnalystAgent()
        analysis = agent.analyze_patient(patient['id'])
        
        # Step 3: Generate care plan
        interface = CareManagerInterface()
        action_plan = interface.generate_action_plan(patient['id'])
        
        # Step 4: Filter for urgent/high priority
        urgent_count = len([t for t in action_plan['tasks'] if t['priority'] == 'urgent'])
        high_count = len([t for t in action_plan['tasks'] if t['priority'] == 'high'])
        
        results.append({
            'patient_id': patient['id'],
            'patient_name': patient['name'],
            'total_cost': patient['total_cost'],
            'priority': action_plan['priority_level'],
            'urgent_tasks': urgent_count,
            'high_tasks': high_count,
            'referrals': len(action_plan['referrals']),
            'sdoh_barriers': len(analysis['sdoh_risks']),
        })
        
        print(f"    Priority: {action_plan['priority_level']}")
        print(f"    Urgent Tasks: {urgent_count}")
        print(f"    SDOH Barriers: {len(analysis['sdoh_risks'])}")
    
    # Step 5: Generate report
    print("\n\nSummary Report:")
    print("-" * 80)
    for result in results:
        print(f"\n{result['patient_name']}")
        print(f"  Cost: ${result['total_cost']:,.2f}")
        print(f"  Priority: {result['priority']}")
        print(f"  Actions: {result['urgent_tasks']} urgent, {result['high_tasks']} high")
        print(f"  Referrals: {result['referrals']}")
        print(f"  SDOH Barriers: {result['sdoh_barriers']}")


def example_6_filter_and_export():
    """Example 6: Filter patients and export results."""
    print("\n" + "=" * 80)
    print("EXAMPLE 6: Filter and Export")
    print("=" * 80)
    
    # Filter patients with substance use disorder
    print("\nFinding patients with substance use disorder...")
    
    batch = BatchCostAnalyst()
    all_patients = []
    
    with open('data/patient_summary.csv', 'r') as f:
        import csv
        reader = csv.DictReader(f)
        for row in reader:
            all_patients.append(row['id'])
    
    print(f"Checking {len(all_patients)} patients...")
    
    sud_patients = []
    agent = CostAnalystAgent()
    
    for patient_id in all_patients[:50]:  # Check first 50
        analysis = agent.analyze_patient(patient_id)
        has_sud = any(p['category'] == 'Substance Use Disorder' 
                     for p in analysis.get('avoidable_patterns', []))
        
        if has_sud:
            sud_patients.append({
                'id': patient_id,
                'name': analysis['name'],
                'cost': float(analysis['cost_summary']['total_cost']),
            })
    
    # Sort by cost
    sud_patients.sort(key=lambda x: x['cost'], reverse=True)
    
    print(f"\nFound {len(sud_patients)} patients with SUD in sample:")
    for patient in sud_patients[:5]:
        print(f"  • {patient['name']}: ${patient['cost']:,.2f}")
    
    # Export to JSON
    import json
    with open('sud_patients.json', 'w') as f:
        json.dump(sud_patients, f, indent=2, default=str)
    
    print(f"\nExported {len(sud_patients)} patients to sud_patients.json")


def main():
    """Run all examples."""
    import sys
    
    examples = {
        '1': ('Single Patient Analysis', example_1_single_patient_analysis),
        '2': ('Plain-Language Briefing', lambda: example_2_generate_briefing(
            example_1_single_patient_analysis())),
        '3': ('Care Manager Action Plan', lambda: example_3_care_manager_plan(
            "9b2a3600-1c8a-52ec-6864-b45f6f6ce66c")),
        '4': ('Batch Analysis', example_4_batch_analysis),
        '5': ('Programmatic Workflow', example_5_programmatic_workflow),
        '6': ('Filter and Export', example_6_filter_and_export),
        'all': ('Run All Examples', None),
    }
    
    if len(sys.argv) > 1 and sys.argv[1] in examples:
        example_num = sys.argv[1]
        if example_num == 'all':
            print("\nRunning all examples...")
            result = example_1_single_patient_analysis()
            example_2_generate_briefing(result)
            example_3_care_manager_plan("9b2a3600-1c8a-52ec-6864-b45f6f6ce66c")
            example_4_batch_analysis()
            example_5_programmatic_workflow()
            example_6_filter_and_export()
        else:
            title, func = examples[example_num]
            print(f"\nRunning: {title}")
            func()
    else:
        print("\nCost Analyst Agent - Quick Start Examples")
        print("=" * 80)
        print("\nUsage: python examples.py <example_number>\n")
        print("Available examples:")
        for num, (title, _) in sorted(examples.items()):
            print(f"  {num}: {title}")
        print("  all: Run all examples")
        print("\nExample: python examples.py 1")


if __name__ == '__main__':
    main()
