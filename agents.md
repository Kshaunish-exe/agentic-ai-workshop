# ShopEasy Multi-Agent System Architecture (`agents.md`)

## 1. Overview & Vision
The **ShopEasy Data Analyst Agent** is a multi-agent AI system designed for D2C e-commerce brands. It empowers non-technical founders, marketers, and operators to paste a Google Sheet CSV URL, submit business questions, receive automated chart recommendations with live previews, and watch a multi-agent pipeline execute in real time. The system strictly uses **Google Gemini 2.5 Flash (`gemini-2.5-flash`)** for reasoning tasks and maintains complete data dynamism—zero hardcoded column names, categories, or metrics.

---

## 2. Multi-Agent Ecosystem

```
+-----------------------------------------------------------------------------------+
|                            ShopEasy Orchestrator Agent                            |
|    - State Machine & Workflow Transitions                                         |
|    - Strict Step Gating (Step 1 -> Step 2 -> Step 3 -> Step 4 -> Step 5)          |
|    - Real-Time Event Dispatch to Operations Console & Status Panel                |
+-------------------------+-----------------------------------+---------------------+
                          |                                   |
                          v                                   v
+--------------------------------------+     +--------------------------------------+
|    Data Ingestion & Schema Agent     |     |   KPI & Metric Discovery Agent       |
| - Google Sheet CSV Parser (RFC 4180) |     | - Dynamic Column Role Classification |
| - DD-MM-YYYY Strict Date Engine      |     | - Revenue, Volume, Delivery Inferences|
| - Statistical Profiling & Data Types |     | - Dynamic KPI Metric Card Generator  |
+-------------------------+------------+     +----------------+---------------------+
                          |                                   |
                          v                                   v
+--------------------------------------+     +--------------------------------------+
|  Chart Recommendation & Visual Agent |     |      Strategic Insight Agent         |
| - Gemini 2.5 Flash Structured Prompt |     | - Gemini 2.5 Flash Streaming Engine  |
| - Axis & Aggregation Mapping Engine  |     | - Root-Cause & Actionable Solutions  |
| - Dynamic Interactive Configuration  |     | - Metric-Grounded Bullet Generator   |
+--------------------------------------+     +--------------------------------------+
```

---

## 3. Individual Agent Specifications

### 3.1. Orchestrator Agent (`OrchestratorAgent`)
- **Role**: Coordinates the entire lifecycle, enforces step gates, maintains global state, and broadcasts real-time telemetry to the UI.
- **Responsibilities**:
  - Gating: Ensures Step 4 never runs before user chart confirmation, and Step 5 never triggers before all charts render.
  - Logging: Emits timestamped operational logs (`[HH:MM:SS] [AGENT_NAME] Message`) to the Operations Console.
  - Lifecycle: Manages agent states (`Waiting`, `Running`, `Complete`, `Failed`).
  - Refresh Loop: Handles global pipeline re-execution upon user request.

### 3.2. Data Ingestion & Schema Agent (`DataIngestionAgent`)
- **Role**: Ingests raw data from Google Sheets CSV, cleanses strings, infers schema, and extracts temporal boundaries.
- **Responsibilities**:
  - Direct CSV fetching via Google Sheets Export URL (`.../export?format=csv` or direct published links).
  - Strict date parsing for **`DD-MM-YYYY`** format (e.g. `24-05-2024` or `01-12-2023`).
  - Dynamic type inference:
    - `date`: Matches `DD-MM-YYYY` patterns.
    - `number`: Numeric strings, currency values (`$`, `₹`, `€`), percentages, commas removed.
    - `category`: Low-cardinality strings (<= 30 distinct values or ratio <= 0.2).
    - `text`: High-cardinality strings, IDs, descriptions.
  - Metadata synthesis: Computes row count, column count, min/max dates, and creates a 3-row sample preview.

### 3.3. KPI & Metric Discovery Agent (`KpiDiscoveryAgent`)
- **Role**: Scans schema and data distributions dynamically to surface executive summary metrics without relying on hardcoded column names.
- **Responsibilities**:
  - Heuristic column semantic matching:
    - *Revenue / Sales*: Detects columns containing 'revenue', 'sales', 'gmv', 'amount', 'total', 'price', 'subtotal', or the highest-magnitude positive continuous currency column.
    - *Orders / Transactions*: Detects columns containing 'order', 'id', 'transaction', 'invoice', or counts total rows.
    - *Delivery / Logistics*: Detects columns containing 'delivery', 'shipping', 'transit', 'lead', 'dispatch' with days/duration.
    - *Secondary Metrics*: Average order value (AOV = Revenue / Orders), units sold, return rates if available.
  - Aggregate computation: Calculates total sums, averages, min/max, formatting appropriately ($/₹/numbers).

### 3.4. Chart Recommendation & Visual Agent (`ChartRecommenderAgent`)
- **Role**: Analyzes the data schema and user business questions to recommend optimal visual representations, axes, and aggregations using Gemini 2.5 Flash.
- **Responsibilities**:
  - Gemini 2.5 Flash Prompting with structured JSON output.
  - Recommends:
    - `chartType`: `bar` | `line` | `donut` | `scatter` | `area`
    - `xAxis`: Column name matching schema
    - `yAxis`: Column name matching schema
    - `aggregation`: `sum` | `avg` | `count` | `none`
    - `reasoning`: Single concise sentence (no jargon) explaining why this chart answers the question.
  - Data Aggregation Engine: Computes group-by aggregations and feeds chart payloads.
  - UI State synchronization: Supports interactive user modifications (dropdowns, live preview thumbnails).

### 3.5. Strategic Insight Agent (`InsightGeneratorAgent`)
- **Role**: Analyzes the aggregated chart data, overall dataset statistics, and KPI cards to generate high-level business intelligence.
- **Responsibilities**:
  - Gated Execution: Only fires once all chart components report `RENDER_COMPLETE`.
  - Gemini 2.5 Flash Streaming API: Streams output bullet-by-bullet in real-time.
  - Strict Business Format Constraints:
    - Maximum 5 crisp actionable bullet points.
    - Every bullet point must quote specific numbers from the dataset.
    - Format: `[Finding with Metric] -> [Direct Business Action]`.
    - No tech/data jargon (no "P-value", "standard deviation", "heteroskedasticity").
    - Explicitly labeled with "AI-Generated Strategic Insights".

---

## 4. Agent Communication & Event Protocol

```typescript
// Shared Event Bus Interface
export type AgentName = 
  | 'Orchestrator' 
  | 'Data Ingestion Agent' 
  | 'KPI Discovery Agent' 
  | 'Chart Recommender Agent' 
  | 'Insight Generator Agent';

export type AgentState = 'Waiting' | 'Running' | 'Complete' | 'Failed';

export interface AgentLogEntry {
  id: string;
  timestamp: string; // HH:MM:SS
  agent: AgentName;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface AgentStatusUpdate {
  agent: AgentName;
  state: AgentState;
  progress?: number;
  error?: string;
}
```

---

## 5. Failure Modes & Resilience Strategies

1. **Google Sheet Access / CORS Issues**:
   - Provide auto-transformation of standard Google Sheets URLs (`/edit#gid=0`) into `/export?format=csv`.
   - Fallback proxy or client-side fetch notification with clear instructions to ensure the sheet is "Published to web" or "Anyone with link can view".
2. **Date Parsing Ambiguities**:
   - Explicit regular expressions for `DD-MM-YYYY` with delimiter flexibility (`-`, `/`, `.`).
   - Rejection of invalid calendar dates (e.g., day > 31 or month > 12).
3. **Gemini API Rate Limiting / Degradation**:
   - Graceful retry with exponential backoff on 429 errors.
   - Structured JSON validation with schema fallback heuristics if LLM response format fails.
4. **Data Size / Performance**:
   - Fast client-side vector aggregation for datasets up to 100,000 rows.
   - Decoupled rendering with requestAnimationFrame to maintain smooth 60fps UI.
