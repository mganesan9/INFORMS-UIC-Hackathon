"""
Cost Analyst Agent for High-Cost Patient Analysis

Analyzes patient costs, encounters, medications, procedures, and financial transactions
to identify cost concentration, avoidable patterns, and generate plain-language briefings
for care managers.
"""

import csv
from collections import defaultdict, Counter
from datetime import datetime
from operator import itemgetter
import json


class CostAnalystAgent:
    """Analyzes high-cost patients and identifies cost drivers and avoidable patterns."""
    
    def __init__(self, data_dir='data/synthea_sample_data_csv_latest'):
        self.data_dir = data_dir
        self.patients = {}
        self.encounters = defaultdict(list)
        self.claims = defaultdict(list)
        self.medications = defaultdict(list)
        self.procedures = defaultdict(list)
        self.conditions = defaultdict(list)
        self.observations = defaultdict(list)
        self.patient_summary = {}
        self.careplans = defaultdict(list)
        
    def load_data(self, patient_id=None):
        """Load relevant patient data from CSV files."""
        # Load patient summary
        with open('data/patient_summary.csv', newline='') as f:
            for row in csv.DictReader(f):
                self.patient_summary[row['id']] = row
        
        # Load patients
        with open(f'{self.data_dir}/patients.csv', newline='') as f:
            for row in csv.DictReader(f):
                self.patients[row['Id']] = row
        
        # Helper to load patient-keyed data
        def load_patient_table(filename, key):
            d = defaultdict(list)
            with open(f'{self.data_dir}/{filename}', newline='') as f:
                for row in csv.DictReader(f):
                    if patient_id and row[key] != patient_id:
                        continue
                    d[row[key]].append(row)
            return d
        
        self.encounters = load_patient_table('encounters.csv', 'PATIENT')
        self.claims = load_patient_table('claims_transactions.csv', 'PATIENTID')
        self.medications = load_patient_table('medications.csv', 'PATIENT')
        self.procedures = load_patient_table('procedures.csv', 'PATIENT')
        self.conditions = load_patient_table('conditions.csv', 'PATIENT')
        self.observations = load_patient_table('observations.csv', 'PATIENT')
        self.careplans = load_patient_table('careplans.csv', 'PATIENT')
    
    def analyze_patient(self, patient_id):
        """Run full cost analysis on a patient."""
        self.load_data(patient_id)
        
        if patient_id not in self.patient_summary:
            return {"error": f"Patient {patient_id} not found"}
        
        summary = self.patient_summary[patient_id]
        patient_info = self.patients.get(patient_id, {})
        
        analysis = {
            'patient_id': patient_id,
            'name': f"{patient_info.get('FIRST', '')} {patient_info.get('LAST', '')}",
            'demographics': self._analyze_demographics(patient_id, patient_info),
            'cost_summary': self._analyze_cost_summary(patient_id, summary),
            'cost_breakdown': self._analyze_cost_breakdown(patient_id),
            'encounter_analysis': self._analyze_encounters(patient_id),
            'medication_analysis': self._analyze_medications(patient_id),
            'procedure_analysis': self._analyze_procedures(patient_id),
            'avoidable_patterns': self._identify_avoidable_patterns(patient_id),
            'sdoh_risks': self._identify_sdoh_risks(patient_id),
        }
        
        return analysis
    
    def _analyze_demographics(self, patient_id, patient_info):
        """Extract demographic and SDOH information."""
        return {
            'dob': patient_info.get('BIRTHDATE'),
            'gender': patient_info.get('GENDER'),
            'race': patient_info.get('RACE'),
            'ethnicity': patient_info.get('ETHNICITY'),
            'city': patient_info.get('CITY'),
            'state': patient_info.get('STATE'),
            'zip': patient_info.get('ZIP'),
            'income': patient_info.get('INCOME'),
            'healthcare_coverage': patient_info.get('HEALTHCARE_COVERAGE'),
            'healthcare_expenses': patient_info.get('HEALTHCARE_EXPENSES'),
        }
    
    def _analyze_cost_summary(self, patient_id, summary):
        """Analyze total costs and high-level metrics."""
        try:
            total_cost = float(summary.get('total_cost', 0))
            ed_inpatient_cost = float(summary.get('ed_inpatient_total_cost', 0))
            ed_visits = int(summary.get('ed_visits', 0))
            inpatient_visits = int(summary.get('inpatient_visits', 0))
            chronic_count = int(summary.get('chronic_condition_count', 0))
            has_careplan = summary.get('has_active_careplan') == '1'
            
            ed_inpatient_pct = (ed_inpatient_cost / total_cost * 100) if total_cost > 0 else 0
            
            return {
                'total_cost': round(total_cost, 2),
                'ed_inpatient_cost': round(ed_inpatient_cost, 2),
                'ed_inpatient_percentage': round(ed_inpatient_pct, 1),
                'ed_visits': ed_visits,
                'inpatient_visits': inpatient_visits,
                'chronic_conditions': chronic_count,
                'has_active_careplan': has_careplan,
            }
        except (ValueError, TypeError):
            return {}
    
    def _analyze_cost_breakdown(self, patient_id):
        """Break down costs by encounter class and claim type."""
        # Aggregate claims by encounter class
        cost_by_class = defaultdict(float)
        claim_count_by_class = defaultdict(int)
        for claim in self.claims[patient_id]:
            try:
                amount = float(claim.get('AMOUNT') or 0)
                encounter_class = claim.get('ENCOUNTERCLASS', 'unknown')
                cost_by_class[encounter_class] += amount
                claim_count_by_class[encounter_class] += 1
            except (ValueError, TypeError):
                pass
        
        # Sort by cost descending
        cost_by_class_sorted = sorted(cost_by_class.items(), key=itemgetter(1), reverse=True)
        
        # Claim types
        claim_types = Counter(c.get('TYPE', 'unknown') for c in self.claims[patient_id])
        
        return {
            'cost_by_encounter_class': [
                {'class': k, 'cost': round(v, 2), 'count': claim_count_by_class[k]}
                for k, v in cost_by_class_sorted
            ],
            'claim_types': dict(claim_types),
        }
    
    def _analyze_encounters(self, patient_id):
        """Analyze encounter patterns and frequency."""
        encounter_classes = Counter(e.get('ENCOUNTERCLASS') for e in self.encounters[patient_id])
        
        # High-risk encounter patterns
        ed_encounters = [e for e in self.encounters[patient_id] if e.get('ENCOUNTERCLASS') == 'emergency']
        inpatient_encounters = [e for e in self.encounters[patient_id] if e.get('ENCOUNTERCLASS') == 'inpatient']
        
        # Recent encounters (last year)
        now = datetime.now()
        recent_ed = sum(1 for e in ed_encounters if e.get('START') and datetime.fromisoformat(e['START'][:10]) > datetime(now.year - 1, now.month, now.day))
        
        return {
            'total_encounters': len(self.encounters[patient_id]),
            'encounter_class_breakdown': dict(encounter_classes),
            'ed_visits': len(ed_encounters),
            'inpatient_visits': len(inpatient_encounters),
            'recent_ed_visits_1yr': recent_ed,
        }
    
    def _analyze_medications(self, patient_id):
        """Analyze medication patterns and costs."""
        total_meds = len(self.medications[patient_id])
        
        # High-cost medications
        med_costs = []
        for med in self.medications[patient_id]:
            try:
                cost = float(med.get('TOTALCOST') or 0)
                if cost > 0:
                    med_costs.append({
                        'description': med.get('DESCRIPTION', 'Unknown'),
                        'cost': cost,
                        'start': med.get('START'),
                        'stop': med.get('STOP'),
                    })
            except (ValueError, TypeError):
                pass
        
        med_costs_sorted = sorted(med_costs, key=itemgetter('cost'), reverse=True)
        top_cost_meds = med_costs_sorted[:10]
        total_med_cost = sum(m['cost'] for m in med_costs)
        
        # Medications with no stop date (ongoing)
        ongoing_meds = [m for m in self.medications[patient_id] if not m.get('STOP')]
        
        return {
            'total_medications': total_meds,
            'total_medication_cost': round(total_med_cost, 2),
            'ongoing_medications': len(ongoing_meds),
            'top_10_cost_medications': [
                {'name': m['description'], 'cost': round(m['cost'], 2), 'start': m['start']}
                for m in top_cost_meds
            ],
        }
    
    def _analyze_procedures(self, patient_id):
        """Analyze procedures and their costs."""
        total_procedures = len(self.procedures[patient_id])
        
        # High-cost procedures
        proc_costs = []
        for proc in self.procedures[patient_id]:
            try:
                cost = float(proc.get('BASE_COST') or 0)
                if cost > 0:
                    proc_costs.append({
                        'description': proc.get('DESCRIPTION', 'Unknown'),
                        'cost': cost,
                        'date': proc.get('START'),
                        'code': proc.get('CODE'),
                    })
            except (ValueError, TypeError):
                pass
        
        proc_costs_sorted = sorted(proc_costs, key=itemgetter('cost'), reverse=True)
        top_cost_procs = proc_costs_sorted[:10]
        total_proc_cost = sum(p['cost'] for p in proc_costs)
        
        # Count repeated procedures
        proc_descriptions = Counter(p.get('DESCRIPTION') for p in self.procedures[patient_id])
        repeated_procs = {k: v for k, v in proc_descriptions.items() if v > 2}
        
        return {
            'total_procedures': total_procedures,
            'total_procedure_cost': round(total_proc_cost, 2),
            'repeated_procedures': repeated_procs,
            'top_10_cost_procedures': [
                {'name': p['description'], 'cost': round(p['cost'], 2), 'code': p['code']}
                for p in top_cost_procs
            ],
        }
    
    def _identify_avoidable_patterns(self, patient_id):
        """Identify patterns that suggest avoidable costs."""
        flags = []
        
        # Pattern 1: High ED visit frequency
        ed_visits = len([e for e in self.encounters[patient_id] if e.get('ENCOUNTERCLASS') == 'emergency'])
        if ed_visits >= 5:
            flags.append({
                'category': 'High ED Utilization',
                'severity': 'high' if ed_visits >= 10 else 'medium',
                'finding': f'{ed_visits} ED visits detected',
                'implication': 'Frequent ED use suggests inadequate primary care or lack of care coordination',
                'action': 'Recommend ED diversion program, care coordination, or primary care enrollment',
            })
        
        # Pattern 2: Multiple inpatient stays
        inpatient_visits = len([e for e in self.encounters[patient_id] if e.get('ENCOUNTERCLASS') == 'inpatient'])
        if inpatient_visits >= 10:
            flags.append({
                'category': 'High Inpatient Utilization',
                'severity': 'high',
                'finding': f'{inpatient_visits} inpatient visits detected',
                'implication': 'Frequent hospitalizations suggest complex disease or poor outpatient management',
                'action': 'Assess for readmission risk, complex care management, or case management',
            })
        
        # Pattern 3: Drug abuse conditions with high costs
        abuse_conditions = [c for c in self.conditions[patient_id] if 'drug' in c.get('DESCRIPTION', '').lower() or 'abuse' in c.get('DESCRIPTION', '').lower() or 'substance' in c.get('DESCRIPTION', '').lower()]
        if abuse_conditions:
            flags.append({
                'category': 'Substance Use Disorder',
                'severity': 'high',
                'finding': f'Substance use conditions detected: {", ".join([c.get("DESCRIPTION", "Unknown")[:40] for c in abuse_conditions[:3]])}',
                'implication': 'Substance use is a major driver of ED visits and hospitalizations',
                'action': 'Refer to addiction medicine, behavioral health, and social services',
            })
        
        # Pattern 4: Chronic pain without active pain management plan
        pain_conditions = [c for c in self.conditions[patient_id] if 'pain' in c.get('DESCRIPTION', '').lower()]
        has_pain_plan = any('pain' in cp.get('DESCRIPTION', '').lower() for cp in self.careplans[patient_id])
        if pain_conditions and not has_pain_plan:
            flags.append({
                'category': 'Chronic Pain Without Care Plan',
                'severity': 'medium',
                'finding': f'Chronic pain conditions detected without active pain management plan',
                'implication': 'Unmanaged pain increases ED visits and costs',
                'action': 'Develop pain management plan, consider pain specialist referral',
            })
        
        # Pattern 5: Multiple ED visits in short timeframe
        recent_ed = []
        now = datetime.now()
        for e in self.encounters[patient_id]:
            if e.get('ENCOUNTERCLASS') == 'emergency' and e.get('START'):
                try:
                    visit_date = datetime.fromisoformat(e['START'][:10])
                    if (now - visit_date).days < 30:
                        recent_ed.append(visit_date)
                except (ValueError, AttributeError):
                    pass
        
        if len(recent_ed) >= 3:
            flags.append({
                'category': 'ED Clustering (Repeat Visits)',
                'severity': 'high',
                'finding': f'{len(recent_ed)} ED visits in the last 30 days',
                'implication': 'Rapid-repeat ED visits suggest acute crisis, inadequate discharge planning, or unmet social needs',
                'action': 'Urgent: Consider hospital-at-home, social work assessment, or intensive case management',
            })
        
        # Pattern 6: High medication count (polypharmacy)
        active_meds = len([m for m in self.medications[patient_id] if not m.get('STOP')])
        if active_meds > 15:
            flags.append({
                'category': 'Polypharmacy Risk',
                'severity': 'medium',
                'finding': f'{active_meds} active medications',
                'implication': 'High medication burden increases adverse drug events and non-adherence',
                'action': 'Conduct medication review, simplify regimen, assess adherence barriers',
            })
        
        # Pattern 7: No active care plan despite high cost
        has_careplan = len([cp for cp in self.careplans[patient_id] if not cp.get('STOP')]) > 0
        total_cost = float(self.patient_summary[patient_id].get('total_cost', 0))
        if not has_careplan and total_cost > 500000:
            flags.append({
                'category': 'No Active Care Plan Despite High Cost',
                'severity': 'high',
                'finding': f'No active care plan; total cost: ${total_cost:,.2f}',
                'implication': 'High-cost patients without care plans lack coordination and are at risk for continued high utilization',
                'action': 'Immediately establish comprehensive care plan with clinical and social components',
            })
        
        return flags
    
    def _identify_sdoh_risks(self, patient_id):
        """Identify social determinants of health that impact costs."""
        risks = []
        patient_info = self.patients.get(patient_id, {})
        
        # Income analysis
        try:
            income = float(patient_info.get('INCOME') or 0)
            if income < 20000:
                risks.append({
                    'sdoh_factor': 'Low Income',
                    'value': f'${income:,.2f}',
                    'impact': 'Financial barriers to medication, preventive care, and healthy behaviors',
                    'action': 'Connect to financial assistance programs, food security, housing support',
                })
        except (ValueError, TypeError):
            pass
        
        # Transportation issues
        transport_issues = [c for c in self.conditions[patient_id] if 'transport' in c.get('DESCRIPTION', '').lower()]
        if transport_issues:
            risks.append({
                'sdoh_factor': 'Transportation Barriers',
                'value': 'Documented lack of access to transportation',
                'impact': 'Missed appointments, delayed care, increased acute visits',
                'action': 'Arrange transportation services, telehealth options, home visits when appropriate',
            })
        
        # Housing instability
        housing_issues = [c for c in self.conditions[patient_id] if 'housing' in c.get('DESCRIPTION', '').lower() or 'homeless' in c.get('DESCRIPTION', '').lower()]
        if housing_issues:
            risks.append({
                'sdoh_factor': 'Housing Instability',
                'value': 'Unsatisfactory housing or homelessness',
                'impact': 'Increased ED/inpatient use, medication non-adherence, mental health issues',
                'action': 'Housing navigation, emergency shelter, coordinate with social services',
            })
        
        # Social isolation
        isolation_conditions = [c for c in self.conditions[patient_id] if 'social' in c.get('DESCRIPTION', '').lower() and 'isolation' in c.get('DESCRIPTION', '').lower()]
        if isolation_conditions:
            risks.append({
                'sdoh_factor': 'Social Isolation',
                'value': 'Limited social contact or social isolation',
                'impact': 'Mental health decline, non-adherence, reduced health outcomes',
                'action': 'Community engagement, mental health referral, peer support programs',
            })
        
        # Limited education
        education_issues = [c for c in self.conditions[patient_id] if 'education' in c.get('DESCRIPTION', '').lower() or 'primary school' in c.get('DESCRIPTION', '').lower()]
        if education_issues:
            risks.append({
                'sdoh_factor': 'Limited Education',
                'value': 'Primary school education only',
                'impact': 'Limited health literacy, difficulty with self-management',
                'action': 'Provide accessible health education, use teach-back method, visual aids',
            })
        
        return risks
    
    def generate_plain_language_briefing(self, analysis):
        """Generate a plain-language executive briefing."""
        patient_id = analysis['patient_id']
        name = analysis['name']
        demographics = analysis['demographics']
        cost_summary = analysis['cost_summary']
        avoidable = analysis['avoidable_patterns']
        sdoh = analysis['sdoh_risks']
        
        briefing = f"""
================================================================================
COST ANALYST BRIEFING: {name.upper()}
Patient ID: {patient_id}
================================================================================

PATIENT OVERVIEW
{'-' * 80}
Age: {demographics.get('dob', 'Unknown')} ({demographics.get('gender', 'Unknown')})
Location: {demographics.get('city')}, {demographics.get('state')} {demographics.get('zip')}
Annual Income: ${demographics.get('income', 'Unknown')}

TOTAL HEALTHCARE COSTS: ${cost_summary['total_cost']:,.2f}
  • Emergency & Inpatient Costs: ${cost_summary['ed_inpatient_cost']:,.2f} ({cost_summary['ed_inpatient_percentage']:.1f}%)
  • Chronic Conditions: {cost_summary['chronic_conditions']}
  • Active Care Plan: {'Yes' if cost_summary['has_active_careplan'] else 'No'}

VISIT PATTERNS
{'-' * 80}
  • ED Visits: {cost_summary['ed_visits']}
  • Inpatient Stays: {cost_summary['inpatient_visits']}
  
HIGH-COST DRIVERS (by category)
{'-' * 80}
"""
        
        for item in analysis['cost_breakdown']['cost_by_encounter_class'][:5]:
            briefing += f"  • {item['class'].upper()}: ${item['cost']:,.2f} ({item['count']} claims)\n"
        
        if analysis['medication_analysis']['top_10_cost_medications']:
            briefing += f"\nTOP MEDICATIONS BY COST\n{'-' * 80}\n"
            for med in analysis['medication_analysis']['top_10_cost_medications'][:5]:
                briefing += f"  • {med['name']}: ${med['cost']:,.2f}\n"
        
        briefing += f"\nAVOIDABLE COST PATTERNS (RED FLAGS)\n{'-' * 80}\n"
        
        if not avoidable:
            briefing += "  • No major red flags detected\n"
        else:
            for i, flag in enumerate(avoidable, 1):
                severity_icon = "🔴" if flag['severity'] == 'high' else "🟡"
                briefing += f"\n{i}. [{severity_icon}] {flag['category']}\n"
                briefing += f"   Finding: {flag['finding']}\n"
                briefing += f"   Why it matters: {flag['implication']}\n"
                briefing += f"   Recommended action: {flag['action']}\n"
        
        if sdoh:
            briefing += f"\nSOCIAL DETERMINANTS OF HEALTH BARRIERS\n{'-' * 80}\n"
            for risk in sdoh:
                briefing += f"\n• {risk['sdoh_factor']}: {risk['value']}\n"
                briefing += f"  Impact: {risk['impact']}\n"
                briefing += f"  Action: {risk['action']}\n"
        
        briefing += f"\nCARE MANAGER ACTION ITEMS\n{'-' * 80}\n"
        
        actions = []
        
        # Generate priority actions based on patterns
        if any(f['category'] == 'High ED Utilization' for f in avoidable):
            actions.append("1. URGENT: Schedule immediate care coordination meeting to assess ED drivers")
        if any(f['category'] == 'ED Clustering (Repeat Visits)' for f in avoidable):
            actions.append("1. URGENT: Follow-up call within 24 hours to assess acute situation")
        if any(f['category'] == 'Substance Use Disorder' for f in avoidable):
            actions.append("2. Refer to addiction medicine and behavioral health services")
        if any(f['category'] == 'No Active Care Plan Despite High Cost' for f in avoidable):
            actions.append("2. CRITICAL: Develop comprehensive care plan within 1 week")
        if any(f['category'] == 'High Inpatient Utilization' for f in avoidable):
            actions.append("3. Assess readmission risk and complex care management needs")
        if any(f['category'] == 'Polypharmacy Risk' for f in avoidable):
            actions.append("4. Request pharmacy review and medication reconciliation")
        if sdoh:
            actions.append("5. Connect patient with social work for SDOH assessment and resources")
        
        if actions:
            for action in actions:
                briefing += f"  {action}\n"
        else:
            briefing += "  No urgent actions required at this time\n"
        
        briefing += "\n" + "=" * 80 + "\n"
        
        return briefing
    
    def export_analysis_json(self, analysis, filename=None):
        """Export analysis to JSON for integration with other systems."""
        if not filename:
            filename = f"analysis_{analysis['patient_id']}.json"
        
        # Convert to JSON-serializable format
        json_data = json.dumps(analysis, indent=2, default=str)
        
        with open(filename, 'w') as f:
            f.write(json_data)
        
        return filename


def main():
    """Example usage of the Cost Analyst Agent."""
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python cost_analyst_agent.py <patient_id>")
        print("\nExample: python cost_analyst_agent.py 9b2a3600-1c8a-52ec-6864-b45f6f6ce66c")
        sys.exit(1)
    
    patient_id = sys.argv[1]
    
    agent = CostAnalystAgent()
    analysis = agent.analyze_patient(patient_id)
    
    if 'error' in analysis:
        print(f"Error: {analysis['error']}")
        sys.exit(1)
    
    # Generate and print plain-language briefing
    briefing = agent.generate_plain_language_briefing(analysis)
    print(briefing)
    
    # Export to JSON
    json_file = agent.export_analysis_json(analysis)
    print(f"\nFull analysis exported to: {json_file}")


if __name__ == '__main__':
    main()
