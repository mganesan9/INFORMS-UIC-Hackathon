# Cost Analyst Agent Documentation

## Overview

The **Cost Analyst Agent** is a comprehensive system for analyzing high-cost patients, identifying cost drivers, flagging avoidable patterns, and generating actionable care manager plans. It processes patient encounters, medications, procedures, conditions, and financial claims to provide plain-language briefings and structured interventions.

## Features

### 1. **Cost Analysis**
- Breaks down total costs by encounter type (ED, inpatient, outpatient, ambulatory)
- Identifies top medications and procedures by cost
- Aggregates claim transactions and financial data
- Calculates cost concentration metrics

### 2. **Avoidable Pattern Detection**
Automatically identifies and flags:
- **High ED Utilization**: Frequent emergency visits suggesting inadequate primary care
- **High Inpatient Utilization**: Frequent hospitalizations indicating poor outpatient management
- **Substance Use Disorder**: Drug abuse conditions that drive costs
- **Chronic Pain Without Care Plan**: Unmanaged pain increasing ED visits
- **ED Clustering**: Rapid-repeat visits in short timeframes (crisis indicators)
- **Polypharmacy Risk**: Too many medications increasing adverse events
- **No Care Plan Despite High Costs**: High-cost patients without coordination

### 3. **Social Determinants of Health (SDOH) Analysis**
Identifies and quantifies barriers:
- Low income and financial barriers
- Transportation challenges
- Housing instability
- Social isolation
- Limited health literacy

### 4. **Plain-Language Reporting**
- Executive briefings for care managers
- Structured action plans with timelines
- Priority-based task lists
- Referral recommendations
- Follow-up schedules

### 5. **Care Manager Interface**
- Generate actionable care plans
- Create task lists with due dates
- Specify referrals with clinical rationales
- Define monitoring metrics and success criteria
- Track follow-up contacts

## Installation & Setup

### Prerequisites
- Python 3.7+
- CSV data files in the expected locations

### Data Structure
The system expects data in: `data/synthea_sample_data_csv_latest/`

Required files:
- `patient_summary.csv` - Pre-computed summary metrics
- `patients.csv` - Demographics and SDOH data
- `encounters.csv` - Visits by type and date
- `claims_transactions.csv` - Financial claim details
- `medications.csv` - Medication records with costs
- `procedures.csv` - Procedure records with costs
- `conditions.csv` - Diagnoses and clinical conditions
- `observations.csv` - Vital signs, labs, survey responses
- `careplans.csv` - Active care plan records

## Usage

### 1. Analyze a Single Patient

```bash
python cost_analyst_agent.py <patient_id>
```

**Example:**
```bash
python cost_analyst_agent.py 9b2a3600-1c8a-52ec-6864-b45f6f6ce66c
```

**Output:**
- Plain-language briefing printed to console
- JSON analysis exported to `analysis_<patient_id>.json`

### 2. Generate Care Manager Action Plan

```bash
python care_manager_interface.py <patient_id>
```

**Output includes:**
- Urgent/high-priority action items with due dates
- Specific referral recommendations
- Follow-up contact schedule
- Monitoring metrics
- Action plan exported to JSON

### 3. Batch Analysis of Top Patients

```bash
python batch_cost_analyst.py [number_of_patients]
```

**Example (analyze top 10):**
```bash
python batch_cost_analyst.py 10
```

**Output:**
- Individual briefings for each patient: `briefing_<patient_id>.txt`
- JSON analyses for each patient: `analysis_<patient_id>.json`
- Executive summary: `executive_summary.txt`
- Aggregated patterns and recommendations across cohort

## Architecture

### Core Components

#### 1. **CostAnalystAgent** (`cost_analyst_agent.py`)
Main analysis engine that:
- Loads and processes patient data
- Calculates cost summaries and breakdowns
- Analyzes encounters, medications, procedures
- Identifies avoidable patterns
- Assesses SDOH barriers
- Generates plain-language briefings

Key methods:
- `analyze_patient(patient_id)` - Run full analysis
- `generate_plain_language_briefing(analysis)` - Create executive summary
- `export_analysis_json(analysis)` - Save structured output

#### 2. **CareManagerInterface** (`care_manager_interface.py`)
Generates actionable care plans:
- `generate_action_plan(patient_id)` - Create structured action plan
- `generate_action_plan_summary(action_plan)` - Text summary
- `export_action_plan(action_plan)` - Save to JSON

#### 3. **BatchCostAnalyst** (`batch_cost_analyst.py`)
Processes multiple patients:
- `analyze_top_patients(n)` - Analyze top N patients by cost
- `generate_executive_summary(analyses)` - Cohort-level insights
- `export_summary_report()` - Save executive summary

## Output Formats

### 1. Plain-Language Briefing (Text)
```
================================================================================
COST ANALYST BRIEFING: PATIENT NAME
Patient ID: xxx-xxx-xxx
================================================================================

PATIENT OVERVIEW
- Demographics and income
- Total costs and visit patterns
- Chronic condition count
- Care plan status

HIGH-COST DRIVERS
- Cost breakdown by encounter type

AVOIDABLE COST PATTERNS (RED FLAGS)
- High ED utilization
- High inpatient utilization
- Substance use disorder
- Chronic pain without care plan
- ED clustering
- Polypharmacy risk

SOCIAL DETERMINANTS OF HEALTH BARRIERS
- Income barriers
- Transportation issues
- Housing instability
- Social isolation

CARE MANAGER ACTION ITEMS
- Urgent/high-priority actions
```

### 2. Structured Analysis (JSON)
```json
{
  "patient_id": "xxx",
  "name": "Patient Name",
  "demographics": {...},
  "cost_summary": {...},
  "cost_breakdown": {...},
  "encounter_analysis": {...},
  "medication_analysis": {...},
  "procedure_analysis": {...},
  "avoidable_patterns": [...],
  "sdoh_risks": [...]
}
```

### 3. Care Manager Action Plan (JSON)
```json
{
  "patient_id": "xxx",
  "patient_name": "Patient Name",
  "priority_level": "urgent|high|medium|low",
  "tasks": [
    {
      "task_id": "T001",
      "title": "Task Title",
      "description": "...",
      "priority": "urgent|high|medium",
      "owner": "Care Manager|Clinician|etc",
      "due_date": "YYYY-MM-DD",
      "success_criteria": [...]
    }
  ],
  "follow_up_schedule": [...],
  "referrals": [...],
  "monitoring_metrics": [...]
}
```

## Pattern Detection Details

### High ED Utilization
- **Trigger**: ≥5 ED visits
- **Implication**: Inadequate primary care, poor care coordination
- **Actions**: ED diversion program, care coordination enrollment

### ED Clustering (Repeat Visits)
- **Trigger**: ≥3 ED visits in 30 days
- **Implication**: Acute crisis or unmet social needs
- **Actions**: URGENT - hospital-at-home, social work assessment, intensive case management

### High Inpatient Utilization
- **Trigger**: ≥10 inpatient stays
- **Implication**: Complex disease or poor outpatient management
- **Actions**: Complex care management, readmission risk assessment

### Substance Use Disorder
- **Trigger**: Drug abuse/misuse diagnoses in conditions
- **Implication**: Major driver of ED/inpatient use
- **Actions**: Addiction medicine referral, behavioral health, MAT evaluation

### Polypharmacy Risk
- **Trigger**: ≥15 active medications
- **Implication**: Medication adverse events, non-adherence
- **Actions**: Pharmacy medication review, regimen simplification

### No Care Plan Despite High Cost
- **Trigger**: Cost > $500K without active care plan
- **Implication**: Lack of coordination, high utilization risk
- **Actions**: CRITICAL - immediately establish comprehensive care plan

## SDOH Detection

The system identifies:

| Barrier | Detection | Impact | Action |
|---------|-----------|--------|--------|
| Low Income | Annual income < $20K | Medication/care barriers | Financial assistance programs |
| Transportation | Transportation access conditions | Missed appointments | Transportation services, telehealth |
| Housing | Housing/homeless conditions | ED/inpatient use | Housing navigation, emergency shelter |
| Social Isolation | Social isolation conditions | Mental health decline | Community engagement, peer support |
| Limited Education | Primary school education only | Health literacy issues | Accessible education, teach-back |

## Integration with Care Management Workflows

### Workflow 1: Urgent Escalation
1. Run cost analysis on high-utilizer
2. Identify RED FLAG patterns (ED clustering, SUD, no care plan)
3. Generate action plan with URGENT priority
4. Route to care manager for same-day contact
5. Track referrals and follow-up

### Workflow 2: Preventive Outreach
1. Run batch analysis on top 20 patients by cost
2. Review executive summary for cohort patterns
3. Identify candidates for ED diversion, addiction services, etc.
4. Generate action plans for medium-to-high priority patients
5. Schedule care manager outreach

### Workflow 3: Program Evaluation
1. Run batch analysis periodically (monthly/quarterly)
2. Track cost trends by patient cohort
3. Measure success on key metrics:
   - ED visit reduction
   - Inpatient day reduction
   - Cost savings
   - Medication adherence
   - Care plan engagement

## Customization

### Adding New Pattern Detectors
Edit `cost_analyst_agent.py`, method `_identify_avoidable_patterns()`:

```python
# Add your pattern detection logic
if <condition>:
    flags.append({
        'category': 'Pattern Name',
        'severity': 'high' or 'medium',
        'finding': 'Description of finding',
        'implication': 'Why it matters',
        'action': 'Recommended action',
    })
```

### Adding New Referral Types
Edit `care_manager_interface.py`, method `_generate_referrals()`:

```python
if <condition>:
    referrals.append({
        'specialty': 'Specialty Name',
        'urgency': 'urgent' or 'high',
        'reason': 'Reason for referral',
        'specific_recommendations': [
            'Recommendation 1',
            'Recommendation 2',
        ],
    })
```

### Modifying Follow-Up Schedules
Edit `care_manager_interface.py`, method `_generate_follow_up_schedule()`:

```python
schedule.append({
    'timepoint': 'Timing',
    'contact_type': 'Phone/In-person/Virtual',
    'owner': 'Contact owner',
    'purpose': 'Purpose of contact',
    'success_metrics': ['Metric 1', 'Metric 2'],
})
```

## Performance Considerations

- **Single patient analysis**: ~2-5 seconds
- **Batch analysis (10 patients)**: ~30-60 seconds
- **Memory usage**: ~200-500MB for full dataset load

For large-scale deployments, consider:
- Lazy loading patient data subsets
- Database backend instead of CSV
- Parallel processing for batch operations

## Limitations

- SDOH detection relies on structured diagnoses in conditions table
- Pattern thresholds are fixed (can be customized for specific populations)
- No predictive modeling; uses current/historical data only
- Does not include clinical protocols or guideline integration

## Future Enhancements

1. **Predictive Modeling**: Forecast future costs and utilization
2. **Clinical Guidelines**: Integrate evidence-based care recommendations
3. **Real-time Alerts**: Flag new patterns as data updates
4. **Outcome Tracking**: Monitor intervention effectiveness
5. **Patient Portal**: Share simplified reports with patients
6. **Integration with EHR**: Direct EMR data pulls and updates

## Support & Troubleshooting

### Missing patient data
**Error**: "Patient XXX not found"
**Solution**: Verify patient_id exists in patient_summary.csv

### File not found errors
**Error**: "No such file or directory: data/..."
**Solution**: Ensure data files are in correct location relative to script

### Empty analysis results
**Error**: Analysis appears incomplete
**Solution**: Verify CSV file formatting and that all required tables are present

## License & Attribution

This cost analyst agent is part of the INFORMS UIC Hackathon project.

---

**Last Updated**: May 1, 2026
**Version**: 1.0
