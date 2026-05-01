"""
Care Manager Interface - Generate action plans and follow-up tasks
"""

from cost_analyst_agent import CostAnalystAgent
from datetime import datetime, timedelta
import json


class CareManagerInterface:
    """Generate structured action plans for care managers based on cost analysis."""
    
    def __init__(self, data_dir='data/synthea_sample_data_csv_latest'):
        self.agent = CostAnalystAgent(data_dir)
    
    def generate_action_plan(self, patient_id):
        """Generate a structured action plan for a care manager."""
        self.agent.load_data(patient_id)
        analysis = self.agent.analyze_patient(patient_id)
        
        if 'error' in analysis:
            return analysis
        
        patient_name = analysis['name']
        patient_id = analysis['patient_id']
        
        action_plan = {
            'patient_id': patient_id,
            'patient_name': patient_name,
            'generated_date': datetime.now().isoformat(),
            'priority_level': self._determine_priority(analysis),
            'tasks': self._generate_tasks(analysis),
            'follow_up_schedule': self._generate_follow_up_schedule(analysis),
            'referrals': self._generate_referrals(analysis),
            'monitoring_metrics': self._generate_monitoring_metrics(analysis),
        }
        
        return action_plan
    
    def _determine_priority(self, analysis):
        """Determine overall priority level (urgent, high, medium, low)."""
        flags = analysis['avoidable_patterns']
        
        high_severity_flags = sum(1 for f in flags if f['severity'] == 'high')
        
        if any(f['category'] == 'ED Clustering (Repeat Visits)' for f in flags):
            return 'urgent'
        elif high_severity_flags >= 3:
            return 'high'
        elif high_severity_flags >= 1:
            return 'medium'
        else:
            return 'low'
    
    def _generate_tasks(self, analysis):
        """Generate specific action tasks."""
        tasks = []
        cost_summary = analysis['cost_summary']
        flags = analysis['avoidable_patterns']
        
        # Task 1: Immediate assessment
        tasks.append({
            'task_id': 'T001',
            'title': 'Conduct Comprehensive Patient Assessment',
            'description': 'Schedule urgent appointment to assess patient\'s current health status, medication adherence, social needs, and barriers to care.',
            'priority': 'urgent',
            'owner': 'Care Manager',
            'due_date': (datetime.now() + timedelta(days=1)).isoformat(),
            'estimated_duration_minutes': 45,
            'success_criteria': ['Assessment completed', 'Barriers documented', 'Patient engaged'],
        })
        
        # Task 2: Cost analysis review
        tasks.append({
            'task_id': 'T002',
            'title': 'Review Cost Drivers with Clinical Team',
            'description': f'Review the patient\'s cost breakdown (Total: ${cost_summary["total_cost"]:,.2f}, ED/Inpatient: {cost_summary["ed_inpatient_percentage"]:.1f}%) and identify primary cost drivers.',
            'priority': 'high',
            'owner': 'Care Manager / Clinician',
            'due_date': (datetime.now() + timedelta(days=2)).isoformat(),
            'estimated_duration_minutes': 30,
        })
        
        # Task 3: Medication review if polypharmacy
        if any(f['category'] == 'Polypharmacy Risk' for f in flags):
            tasks.append({
                'task_id': 'T003',
                'title': 'Pharmacist Medication Review',
                'description': 'Request comprehensive medication review to identify redundancies, adverse interactions, and deprescribing opportunities.',
                'priority': 'high',
                'owner': 'Pharmacist',
                'due_date': (datetime.now() + timedelta(days=3)).isoformat(),
                'estimated_duration_minutes': 60,
                'success_criteria': ['Medication list reconciled', 'Drug interactions checked', 'Deprescribing recommendations provided'],
            })
        
        # Task 4: ED diversion if high utilization
        if any(f['category'] in ['High ED Utilization', 'ED Clustering (Repeat Visits)'] for f in flags):
            tasks.append({
                'task_id': 'T004',
                'title': 'Implement ED Diversion Strategy',
                'description': 'Develop plan to reduce ED visits: ensure primary care enrollment, establish care coordination, arrange urgent/same-day appointments.',
                'priority': 'high',
                'owner': 'Care Manager',
                'due_date': (datetime.now() + timedelta(days=3)).isoformat(),
                'estimated_duration_minutes': 60,
                'success_criteria': ['Primary care established', 'Coordinator assigned', 'Patient educated on alternatives'],
            })
        
        # Task 5: Addiction services if SUD
        if any(f['category'] == 'Substance Use Disorder' for f in flags):
            tasks.append({
                'task_id': 'T005',
                'title': 'Refer to Addiction Medicine and Behavioral Health',
                'description': 'Coordinate referral to addiction medicine, psychiatry, and social work. Discuss medication-assisted treatment options.',
                'priority': 'urgent',
                'owner': 'Care Manager / Clinician',
                'due_date': (datetime.now() + timedelta(days=1)).isoformat(),
                'estimated_duration_minutes': 30,
                'success_criteria': ['Referral sent', 'Patient acceptance obtained', 'Appointment scheduled'],
            })
        
        # Task 6: Social work assessment
        if analysis['sdoh_risks']:
            tasks.append({
                'task_id': 'T006',
                'title': 'Social Work SDOH Assessment',
                'description': 'Connect patient with social work for comprehensive assessment of social determinants: housing, transportation, food security, financial support.',
                'priority': 'high',
                'owner': 'Social Worker',
                'due_date': (datetime.now() + timedelta(days=2)).isoformat(),
                'estimated_duration_minutes': 60,
                'success_criteria': ['SDOH barriers identified', 'Resources offered', 'Support plan created'],
            })
        
        # Task 7: Care plan development
        if not cost_summary['has_active_careplan']:
            tasks.append({
                'task_id': 'T007',
                'title': 'Develop Comprehensive Care Plan',
                'description': 'Create documented care plan addressing: medical conditions, medications, functional limitations, social needs, goals, and follow-up schedule.',
                'priority': 'urgent',
                'owner': 'Care Team',
                'due_date': (datetime.now() + timedelta(days=3)).isoformat(),
                'estimated_duration_minutes': 90,
                'success_criteria': ['Care plan documented', 'Patient/caregiver educated', 'Shared with all providers'],
            })
        
        return tasks
    
    def _generate_follow_up_schedule(self, analysis):
        """Generate follow-up contact schedule."""
        priority = self._determine_priority(analysis)
        flags = analysis['avoidable_patterns']
        
        schedule = []
        
        # Initial follow-up
        if priority == 'urgent':
            schedule.append({
                'timepoint': 'Day 1-3',
                'contact_type': 'Phone',
                'owner': 'Care Manager',
                'purpose': 'Urgent assessment and crisis intervention',
                'success_metrics': ['Patient contacted', 'Immediate safety assessed', 'Next steps discussed'],
            })
            schedule.append({
                'timepoint': 'Day 5-7',
                'contact_type': 'In-person visit',
                'owner': 'Care Manager / Clinician',
                'purpose': 'Comprehensive assessment and care plan initiation',
                'success_metrics': ['Assessment completed', 'Care plan started', 'Referrals placed'],
            })
        elif priority == 'high':
            schedule.append({
                'timepoint': 'Day 3-7',
                'contact_type': 'Phone',
                'owner': 'Care Manager',
                'purpose': 'Initial outreach and scheduling',
                'success_metrics': ['Patient engaged', 'Appointment scheduled'],
            })
            schedule.append({
                'timepoint': 'Week 2',
                'contact_type': 'In-person visit',
                'owner': 'Care Manager',
                'purpose': 'Comprehensive assessment and care plan',
                'success_metrics': ['Assessment completed', 'Plan initiated'],
            })
        
        # Ongoing monitoring
        schedule.append({
            'timepoint': 'Monthly',
            'contact_type': 'Phone/Virtual',
            'owner': 'Care Manager',
            'purpose': 'Monitor adherence, barriers, and cost reduction progress',
            'success_metrics': ['Patient status documented', 'Progress toward goals assessed'],
        })
        
        schedule.append({
            'timepoint': 'Quarterly',
            'contact_type': 'In-person visit',
            'owner': 'Care Team',
            'purpose': 'Comprehensive reassessment and care plan update',
            'success_metrics': ['Progress reviewed', 'Goals adjusted as needed', 'Utilization trends assessed'],
        })
        
        return schedule
    
    def _generate_referrals(self, analysis):
        """Generate specific referral recommendations."""
        referrals = []
        flags = analysis['avoidable_patterns']
        sdoh = analysis['sdoh_risks']
        
        # Clinical referrals
        if any(f['category'] == 'Substance Use Disorder' for f in flags):
            referrals.append({
                'specialty': 'Addiction Medicine',
                'urgency': 'urgent',
                'reason': 'Substance use disorder documented',
                'specific_recommendations': [
                    'Evaluate for medication-assisted treatment (methadone, buprenorphine)',
                    'Screen for opioid use disorder specifically',
                    'Assess medication history and triggers',
                ],
            })
            referrals.append({
                'specialty': 'Behavioral Health / Psychiatry',
                'urgency': 'high',
                'reason': 'Co-occurring mental health and substance use',
                'specific_recommendations': [
                    'Screen for depression, anxiety, PTSD',
                    'Evaluate for trauma history',
                    'Consider integrated treatment approach',
                ],
            })
        
        if any(f['category'] == 'Chronic Pain Without Care Plan' for f in flags):
            referrals.append({
                'specialty': 'Pain Management',
                'urgency': 'high',
                'reason': 'Unmanaged chronic pain driving costs',
                'specific_recommendations': [
                    'Develop multimodal pain management plan',
                    'Consider physical therapy, non-opioid options first',
                    'Evaluate for opioid use disorder risk if on opioids',
                ],
            })
        
        if any(f['category'] == 'High Inpatient Utilization' for f in flags):
            referrals.append({
                'specialty': 'Complex Care Management',
                'urgency': 'high',
                'reason': 'High inpatient utilization requiring intensive coordination',
                'specific_recommendations': [
                    'Enroll in complex care management program',
                    'Assign primary care physician with care coordination',
                    'Schedule regular care coordination meetings',
                ],
            })
        
        # SDOH referrals
        if any(r['sdoh_factor'] == 'Transportation Barriers' for r in sdoh):
            referrals.append({
                'specialty': 'Transportation Services',
                'urgency': 'high',
                'reason': 'Transportation barriers to care',
                'specific_recommendations': [
                    'Arrange non-emergency medical transportation',
                    'Connect to community transportation programs',
                    'Consider telehealth options',
                ],
            })
        
        if any(r['sdoh_factor'] == 'Housing Instability' for r in sdoh):
            referrals.append({
                'specialty': 'Social Work / Housing Services',
                'urgency': 'urgent',
                'reason': 'Housing instability',
                'specific_recommendations': [
                    'Connect to emergency shelter resources',
                    'Apply for housing assistance programs',
                    'Coordinate with homeless outreach services',
                ],
            })
        
        if any(r['sdoh_factor'] == 'Low Income' for r in sdoh):
            referrals.append({
                'specialty': 'Financial Assistance / Benefits',
                'urgency': 'high',
                'reason': 'Financial barriers to care',
                'specific_recommendations': [
                    'Screen for Medicaid, SSI, food assistance',
                    'Connect to prescription assistance programs',
                    'Refer to hospital financial counselor',
                ],
            })
        
        return referrals
    
    def _generate_monitoring_metrics(self, analysis):
        """Define metrics to track progress."""
        metrics = [
            {
                'metric': 'ED Visit Frequency',
                'target': 'Reduce by 50% in 6 months',
                'measurement': 'Count of ED visits per month',
                'tracking_interval': 'Monthly',
            },
            {
                'metric': 'Inpatient Days',
                'target': 'Reduce by 30% in 6 months',
                'measurement': 'Total inpatient days per month',
                'tracking_interval': 'Monthly',
            },
            {
                'metric': 'Medication Adherence',
                'target': '≥80% adherence to prescribed medications',
                'measurement': 'Patient self-report, pharmacy fill data',
                'tracking_interval': 'Monthly',
            },
            {
                'metric': 'Care Plan Engagement',
                'target': 'Patient participating in 100% of scheduled follow-ups',
                'measurement': 'Attendance at appointments',
                'tracking_interval': 'Each visit',
            },
            {
                'metric': 'Total Cost',
                'target': 'Reduce cost per patient by 20% in 12 months',
                'measurement': 'Total paid claims',
                'tracking_interval': 'Quarterly',
            },
            {
                'metric': 'SDOH Needs Met',
                'target': 'Address all identified barriers',
                'measurement': 'Number of barriers with active support in place',
                'tracking_interval': 'Quarterly',
            },
        ]
        
        return metrics
    
    def export_action_plan(self, action_plan, filename=None):
        """Export action plan to JSON."""
        if not filename:
            filename = f"action_plan_{action_plan['patient_id']}.json"
        
        with open(filename, 'w') as f:
            json.dump(action_plan, f, indent=2, default=str)
        
        return filename
    
    def generate_action_plan_summary(self, action_plan):
        """Generate text summary of action plan."""
        summary = f"""
================================================================================
CARE MANAGER ACTION PLAN
Patient: {action_plan['patient_name']} (ID: {action_plan['patient_id']})
Generated: {action_plan['generated_date']}
Priority Level: {action_plan['priority_level'].upper()}
================================================================================

IMMEDIATE ACTION ITEMS
{'-' * 80}
"""
        urgent_tasks = [t for t in action_plan['tasks'] if t['priority'] == 'urgent']
        high_tasks = [t for t in action_plan['tasks'] if t['priority'] == 'high']
        
        for i, task in enumerate(urgent_tasks + high_tasks, 1):
            summary += f"\n{i}. {task['title']} (Due: {task['due_date'][:10]})\n"
            summary += f"   Owner: {task['owner']}\n"
            summary += f"   Duration: ~{task['estimated_duration_minutes']} minutes\n"
            summary += f"   Description: {task['description']}\n"
            if 'success_criteria' in task:
                summary += f"   Success Criteria: {', '.join(task['success_criteria'])}\n"
        
        summary += f"\n\nREFERRALS NEEDED\n{'-' * 80}\n"
        for referral in action_plan['referrals']:
            summary += f"\n• {referral['specialty']} ({referral['urgency'].upper()})\n"
            summary += f"  Reason: {referral['reason']}\n"
            for rec in referral['specific_recommendations']:
                summary += f"  - {rec}\n"
        
        summary += f"\n\nFOLLOW-UP SCHEDULE\n{'-' * 80}\n"
        for follow_up in action_plan['follow_up_schedule']:
            summary += f"\n• {follow_up['timepoint']}: {follow_up['contact_type']} contact by {follow_up['owner']}\n"
            summary += f"  Purpose: {follow_up['purpose']}\n"
        
        summary += f"\n\nMONITORING METRICS\n{'-' * 80}\n"
        for metric in action_plan['monitoring_metrics']:
            summary += f"\n• {metric['metric']}\n"
            summary += f"  Target: {metric['target']}\n"
            summary += f"  Tracking: {metric['tracking_interval']}\n"
        
        summary += "\n" + "=" * 80 + "\n"
        
        return summary


def main():
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python care_manager_interface.py <patient_id>")
        sys.exit(1)
    
    patient_id = sys.argv[1]
    
    interface = CareManagerInterface()
    action_plan = interface.generate_action_plan(patient_id)
    
    if 'error' in action_plan:
        print(f"Error: {action_plan['error']}")
        sys.exit(1)
    
    # Print action plan summary
    summary = interface.generate_action_plan_summary(action_plan)
    print(summary)
    
    # Export to JSON
    json_file = interface.export_action_plan(action_plan)
    print(f"Full action plan exported to: {json_file}")


if __name__ == '__main__':
    main()
