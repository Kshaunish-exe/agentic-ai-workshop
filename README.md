# ShopEasy Data Analyst Agent — Agentic AI Workshop

A multi-agent AI system designed for D2C e-commerce brands. Paste any Google Sheet CSV URL, submit business questions, receive automated chart recommendations with live previews, and watch the multi-agent pipeline execute in real time.

Powered strictly by **Google Gemini 2.5 Flash (`gemini-2.5-flash`)**.

---

## 🌟 Key Highlights

- **Complete Data Dynamism**: Zero hardcoded column names, categories, or metrics. Works with any dataset structure.
- **Strict `DD-MM-YYYY` Date Standard**: Dedicated date engine enforcing `DD-MM-YYYY` parsing and formatting across headers, chips, and axes.
- **Strict Sequential Gating**:
  - **Step 1: Data Source Input** $\rightarrow$ Silent fetch $\rightarrow$ Schema preview table & 3 sample rows $\rightarrow$ User Confirmation.
  - **Step 2: Business Questions** $\rightarrow$ 1 to 5 plain-English questions with helpful placeholders $\rightarrow$ User Submission.
  - **Step 3: AI Chart Recommendations** $\rightarrow$ Gemini 2.5 Flash recommends chart type, axes, and reasoning $\rightarrow$ Editable cards with live thumbnail previews $\rightarrow$ User Confirmation.
  - **Step 4: Dashboard Renders** $\rightarrow$ Agent Status Panel & Operations Console stream live progress $\rightarrow$ Dynamic KPI cards $\rightarrow$ Sequential chart rendering.
  - **Step 5: Real-Time Streaming Insights** $\rightarrow$ Triggered **only after all charts render** $\rightarrow$ Up to 5 actionable metric-grounded bullets streamed in real time via Gemini 2.5 Flash.
- **Full Pipeline Refresh**: Header refresh button reruns the entire pipeline from scratch.

---

## 🚀 How to Run

A local HTTP server can be launched on port **8000**:

```bash
# Start server:
python -m http.server 8000

# Open in your web browser:
http://localhost:8000
```

Alternatively, you can open `index.html` directly in any modern web browser.

---

## 🔑 Gemini API Key Configuration
Click the **Gemini 2.5 Flash Key** button in the dashboard header:
- Paste your API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
- Stored securely in `localStorage`.
- If no key is provided, the application includes a smart heuristic fallback so you can explore the full multi-agent flow immediately.

---

## 📁 Repository Structure
- [`index.html`](index.html): Complete UI shell, dark theme, wizard navigation, and modal systems.
- [`app.js`](app.js): Multi-agent orchestrator, `DD-MM-YYYY` date engine, RFC 4180 CSV parser, Chart.js visualizer, and Gemini 2.5 Flash SSE streaming engine.
- [`agents.md`](agents.md): Formal agent specifications, contracts, and state machines.
- [`instructions.md`](instructions.md): System architecture, execution barriers, and step-by-step specifications.
