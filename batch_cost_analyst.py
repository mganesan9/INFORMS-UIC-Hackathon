"""
Batch Cost Analyst - Run analysis on multiple patients and generate reports
"""

import csv
from cost_analyst_agent import CostAnalystAgent
import json
from datetime import datetime


class BatchCostAnalyst:
    """Batch process multiple patients for cost analysis."""
    
    def __init__(self, data_dir='data/synthea_sample_data_csv_latest'):
        self.agent = CostAnalystAgent(data_dir)
        self.agent.load_data()
    
    def get_top_cost_patients(self, n=10):
        """Get top N patients by cost."""
        patients = []
        with open('data/patient_summary.csv', newline='') as f:
            for row in csv.DictReader(f):
                try:
                    patients.append({
                        'id': row['id'],
                        'name': f"{row['first']} {row['last']}",
                        'total_cost': float(row['total_cost']),
                        'ed_inpatient_cost': float(row['ed_inpatient_total_cost']),
                    })
                except (ValueError, TypeError):
                    pass
        
        patients.sort(key=lambda x: x['total_cost'], reverse=True)
        return patients[:n]
    
    def analyze_top_patients(self, n=10, save_reports=True):
        """Analyze top N most expensive patients."""
        top_patients = self.get_top_cost_patients(n)
        results = []
        
        print(f"\n{'Analyzing top {0} most expensive patients...'.format(n)}")
        print("=" * 80)
        
        for i, patient in enumerate(top_patients, 1):
            print(f"\n[{i}/{len(top_patients)}] Analyzing {patient['name']} (${patient['total_cost']:,.2f})...")
            
            analysis = self.agent.analyze_patient(patient['id'])
            
            if 'error' not in analysis:
                results.append(analysis)
                
                if save_reports:
                    # Save individual briefing
                    briefing = self.agent.generate_plain_language_briefing(analysis)
                    briefing_file = f"briefing_{patient['id']}.txt"
                    with open(briefing_file, 'w') as f:
                        f.write(briefing)
                    
                    # Save JSON analysis
                    json_file = self.agent.export_analysis_json(analysis)
                    
                    print(f"   ✓ Saved to {briefing_file} and {json_file}")
        
        return results
    
    def generate_executive_summary(self, analyses):
        """Generate high-level executive summary across patients."""
        summary = f"""
================================================================================
COST ANALYST EXECUTIVE SUMMARY
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
================================================================================

COHORT OVERVIEW
{'-' * 80}
Total Patients Analyzed: {len(analyses)}
Total Cohort Cost: ${sum(float(a['cost_summary']['total_cost']) for a in analyses):,.2f}
Average Cost per Patient: ${sum(float(a['cost_summary']['total_cost']) for a in analyses) / len(analyses):,.2f}

TOP RED FLAGS ACROSS COHORT
{'-' * 80}
"""
        
        # Aggregate flags
        all_flags = {}
        for analysis in analyses:
            for flag in analysis['avoidable_patterns']:
                category = flag['category']
                if category not in all_flags:
                    all_flags[category] = {'count': 0, 'severity': flag['severity']}
                all_flags[category]['count'] += 1
        
        # Sort by count
        sorted_flags = sorted(all_flags.items(), key=lambda x: x[1]['count'], reverse=True)
        
        for flag_name, flag_data in sorted_flags[:10]:
            severity_icon = "🔴" if flag_data['severity'] == 'high' else "🟡"
            summary += f"  {severity_icon} {flag_name}: {flag_data['count']} patients\n"
        
        # SDOH barriers
        all_sdoh = {}
        for analysis in analyses:
            for risk in analysis['sdoh_risks']:
                factor = risk['sdoh_factor']
                if factor not in all_sdoh:
                    all_sdoh[factor] = 0
                all_sdoh[factor] += 1
        
        if all_sdoh:
            summary += f"\nSOCIAL DETERMINANTS OF HEALTH BARRIERS\n{'-' * 80}\n"
            for factor, count in sorted(all_sdoh.items(), key=lambda x: x[1], reverse=True):
                pct = (count / len(analyses)) * 100
                summary += f"  • {factor}: {count} patients ({pct:.1f}%)\n"
        
        summary += f"\nRECOMMENDED PRIORITIES\n{'-' * 80}\n"
        
        # Priority recommendations
        priorities = []
        
        high_ed_count = sum(1 for a in analyses for f in a['avoidable_patterns'] if f['category'] == 'High ED Utilization' and f['severity'] == 'high')
        if high_ed_count > 0:
            priorities.append(f"1. Launch ED diversion program ({high_ed_count} high-utilizers identified)")
        
        substance_count = sum(1 for a in analyses for f in a['avoidable_patterns'] if f['category'] == 'Substance Use Disorder')
        if substance_count > 0:
            priorities.append(f"2. Expand addiction medicine and behavioral health services ({substance_count} patients with SUD)")
        
        no_plan_count = sum(1 for a in analyses for f in a['avoidable_patterns'] if f['category'] == 'No Active Care Plan Despite High Cost')
        if no_plan_count > 0:
            priorities.append(f"3. Implement care plans for high-cost patients without plans ({no_plan_count} patients)")
        
        low_income_pct = (all_sdoh.get('Low Income', 0) / len(analyses)) * 100
        if low_income_pct > 30:
            priorities.append(f"4. Strengthen financial assistance and social services access ({low_income_pct:.0f}% of cohort low-income)")
        
        for priority in priorities:
            summary += f"  {priority}\n"
        
        summary += "\n" + "=" * 80 + "\n"
        
        return summary
    
    def export_summary_report(self, analyses, filename='executive_summary.txt'):
        """Export executive summary to file."""
        summary = self.generate_executive_summary(analyses)
        with open(filename, 'w') as f:
            f.write(summary)
        print(f"\nExecutive summary saved to: {filename}")
        return filename


def main():
    import sys
    
    n_patients = 10
    if len(sys.argv) > 1:
        try:
            n_patients = int(sys.argv[1])
        except ValueError:
            print("Usage: python batch_cost_analyst.py [number_of_patients]")
            sys.exit(1)
    
    batch = BatchCostAnalyst()
    analyses = batch.analyze_top_patients(n=n_patients, save_reports=True)
    
    # Print executive summary
    summary = batch.generate_executive_summary(analyses)
    print("\n" + summary)
    
    # Export
    batch.export_summary_report(analyses)


if __name__ == '__main__':
    main()
