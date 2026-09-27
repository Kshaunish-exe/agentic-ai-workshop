# ShopEasy Data Analyst Agent — Operational Instructions (`instructions.md`)

## 1. Project Overview & Philosophy
The **ShopEasy Data Analyst Agent** is a production-grade, zero-configuration live analytics web dashboard for direct-to-consumer (D2C) brands. The philosophy of the application is:
- **Zero hardcoding**: All columns, metrics, dimensions, questions, and insights are dynamically extracted from user-supplied data.
- **Strict User Journey Gating**: Steps must proceed sequentially (Step 1 -> Step 2 -> Step 3 -> Step 4 -> Step 5) with explicit user confirmations.
- **Strict Model Enforcement**: Exclusively use **Google Gemini 2.5 Flash (`gemini-2.5-flash`)** for all generative AI reasoning, recommendations, and streaming insights.
- **Strict Date Standard**: All incoming and rendered dates must adhere to **`DD-MM-YYYY`** formatting.

---

## 2. User Journey Specifications

### Step 1: Data Source Input
1. **Input Interface**: Clean, focused screen with an input field prompting the user to paste their Google Sheet CSV URL.
2. **URL Normalization**: Automatically convert standard Google Sheets URLs (e.g., `https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={GID}`) into direct CSV export endpoints (`https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={GID}`).
3. **Silent Fetch & Parse**:
   - RFC 4180 compliant CSV parser.
   - Detect data types:
     - `date`: Matches `DD-MM-YYYY` (e.g. `15-08-2024`).
     - `number`: Floating point, currency, integers, negative values.
     - `category`: String fields with low unique count relative to row total.
     - `text`: Freeform text or high cardinality identifiers.
4. **Data Schema Preview Display**:
   - Table displaying column names, detected data types, and non-empty count.
   - 3-row sample data preview table with clean zebra striping and sticky headers.
   - Metadata chips: Total row count, detected date range (Start: `DD-MM-YYYY` to End: `DD-MM-YYYY`).
5. **Confirmation Action**: "Confirm & Continue" button to unlock Step 2.

### Step 2: Business Questions Input
1. **Interactive Form**: 1 to 5 dynamic question input fields.
2. **Requirement**: Minimum 1 question required to proceed. "+ Add Question" button to add up to 5 questions; trash icon to remove.
3. **Contextual Placeholders**: Provide non-technical placeholder examples, e.g.:
   - *"Which product category generated the highest total revenue?"*
   - *"How do order volumes trend month over month?"*
   - *"Which delivery zones have the longest shipping delays?"*
4. **Submission Action**: "Generate AI Chart Configurations" triggers Step 3.

### Step 3: AI Chart Recommendations & Interactive Editing
1. **Gemini 2.5 Flash Recommendation Call**:
   - Pass schema summary (column names + types) and user questions.
   - Request structured JSON response containing:
     - `questionIndex`: index
     - `chartType`: `bar` | `line` | `donut` | `scatter` | `area`
     - `xAxis`: Recommended column name
     - `yAxis`: Recommended column name
     - `aggregation`: `sum` | `avg` | `count`
     - `reasoning`: Plain English justification (1 sentence, no jargon).
2. **Editable Recommendation Cards**:
   - One card per question displaying the recommended chart type, X/Y column selectors, and AI reasoning badge.
   - **Interactive Dropdowns**:
     - Chart Type dropdown (`Bar Chart`, `Line Trend`, `Donut Breakdown`, `Scatter Plot`, `Area Chart`).
     - X-Axis & Y-Axis dropdowns dynamically populated with actual columns from the dataset.
     - Aggregation dropdown (`Sum`, `Average`, `Count`).
   - **Live Mini-Preview**: Real-time thumbnail preview updating synchronously as dropdown values change.
3. **Confirmation Action**: "Confirm All Configurations & Build Dashboard" unlocks Step 4.

### Step 4: Multi-Agent Execution & Dashboard Rendering
1. **Sequence Trigger**:
   - Agent Status Panel activates.
   - Agent Operations Console begins emitting timestamped logs.
   - `Orchestrator` -> `DataIngestionAgent` (verifies) -> `KpiDiscoveryAgent` (calculates KPIs) -> `ChartRecommenderAgent` (renders charts sequentially).
2. **KPI Summary Cards**:
   - Dynamically computed from dataset columns (e.g., Total Revenue, Total Orders, Average Delivery Days, AOV).
   - Formatted cleanly with currency symbols and standard delimiters.
3. **Chart Grid**:
   - Charts render sequentially with smooth entry animations.
   - Each chart card is titled with the exact user question.
   - Interactive tooltips, zoom/pan support, and responsive resizing.
4. **Rendering Gate**: Every chart emits a completion event. Only after all charts reach `RENDER_COMPLETE` does Step 5 unlock.

### Step 5: AI Strategic Insights Generation
1. **Insight Generator Agent Activation**:
   - Triggers automatically and exclusively after all charts are rendered.
   - Compiles executive summary: KPI totals, chart aggregations, top performers, lowest performers, and temporal trends.
2. **Gemini 2.5 Flash Streaming Execution**:
   - Sends payload to `gemini-2.5-flash` with streaming enabled.
   - Output format: Maximum 5 crisp actionable bullet points.
   - Every bullet must cite exact figures and follow: `[Finding with Metric] — [Direct Actionable Business Recommendation]`.
   - Real-time streaming UI: Tokens/bullets appear progressively with typing/pulse indicator.
   - Badge: Clearly labeled "AI-Generated Strategic Insights via Gemini 2.5 Flash".

---

## 3. UI/UX Components & Layout Hierarchy

```
+-----------------------------------------------------------------------------------+
| 1. Dashboard Header                                                               |
|    [ShopEasy Logo] | [Date Range: DD-MM-YYYY to DD-MM-YYYY] | [Sheet Link] | [Refresh] | [● Live] |
+-----------------------------------------------------------------------------------+
| 2. Agent Status Panel (Horizontal Strip)                                          |
|    [Ingestion: Done] -> [KPIs: Done] -> [Charts: Done] -> [Insights: Streaming]   |
+-----------------------------------------------------------------------------------+
| 3. Agent Operations Console (Collapsible Dark Terminal)                           |
|    > [12:04:02] [DataIngestionAgent] Parsed 1,420 rows. Date range validated.     |
|    > [12:04:03] [KpiDiscoveryAgent] Detected Revenue ($142.5k) and Orders (1,420)|
+-----------------------------------------------------------------------------------+
| 4. KPI Summary Cards Grid                                                         |
|    [Total Revenue: $142,500] | [Total Orders: 1,420] | [Avg Delivery: 3.4 Days]   |
+-----------------------------------------------------------------------------------+
| 5. Interactive Chart Grid (2-column responsive layout)                            |
|    +-----------------------------+       +-----------------------------+          |
|    | Question 1 Chart (Bar)      |       | Question 2 Chart (Line)     |          |
|    +-----------------------------+       +-----------------------------+          |
+-----------------------------------------------------------------------------------+
| 6. AI Strategic Insights Section                                                  |
|    • [Metric Insight 1]                                                           |
|    • [Metric Insight 2]                                                           |
+-----------------------------------------------------------------------------------+
```

---

## 4. Technical Stack & Architecture

- **Frontend Core**: Single Page Application with clean, modern Tailwind CSS / responsive layout styling.
- **Visualization Library**: Chart.js / Chart.js DataLabels or Apache ECharts for high performance, dynamic typing, and responsive canvas charts.
- **CSV & Data Engine**: Custom robust RFC 4180 CSV parser + client-side data frame aggregation engine.
- **LLM SDK / API**: Official Google Gen AI SDK (`@google/genai` or direct Gemini REST endpoint with SSE streaming) using model `gemini-2.5-flash`.
- **API Key Handling**: Secure client-side configuration modal with local storage persistence or environment variable fallback.

---

## 5. Date Parsing & Handling Rules (`DD-MM-YYYY`)
1. Inbound format: Strings such as `28-02-2024`, `05/11/2023`, `01.01.2025`.
2. Parser logic:
   - Split by `[-/.]`.
   - Day = token 0, Month = token 1 (1-indexed), Year = token 2.
   - Internal timestamp representation = `Date.UTC(Year, Month - 1, Day)`.
3. Output format: All tooltips, axis labels, previews, and header badges must re-format using `DD-MM-YYYY`.

---

## 6. Refresh Pipeline Rules
When the user clicks the "Refresh" button in the dashboard header:
1. Reset insight section and chart instances.
2. Set all agent states back to `Waiting`.
3. Clear the Operations Console (or print a `=== PIPELINE REFRESH INITIATED ===` divider).
4. Refetch data from the Google Sheet CSV URL.
5. Re-run `DataIngestionAgent`, re-verify schema.
6. Re-run `KpiDiscoveryAgent`, recompute KPI metrics.
7. Re-aggregate and re-render charts.
8. Re-trigger `InsightGeneratorAgent` to stream fresh strategic insights.
