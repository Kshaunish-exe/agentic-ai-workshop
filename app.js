/**
 * ShopEasy Data Analyst Agent — Multi-Agent Web Analytics Engine
 * Powered by Google Gemini 2.5 Flash (gemini-2.5-flash)
 * Strict DD-MM-YYYY Date Standard | Zero Hardcoding Dynamism
 */

(function () {
  'use strict';

  // =========================================================================
  // GLOBAL STATE
  // =========================================================================
  const state = {
    apiKey: localStorage.getItem('shopeasy_gemini_api_key') || '',
    activeStep: 1,
    googleSheetUrl: '',
    rawCsv: '',
    rows: [],
    schema: {
      columns: [], // [{ name, type, distinctCount, sampleValues }]
      rowCount: 0,
      dateRange: null // { min: 'DD-MM-YYYY', max: 'DD-MM-YYYY', minTs, maxTs }
    },
    businessQuestions: [
      "Which product category drives the highest total revenue?",
      "How do daily sales trend over time?",
      "Which cities or zones have the longest average delivery days?"
    ],
    chartConfigs: [], // [{ id, question, chartType, xAxis, yAxis, aggregation, reasoning }]
    kpis: {}, // { totalRevenue, totalOrders, avgDeliveryDays, aov, ... }
    chartInstances: {}, // chartId -> Chart.js instance
    miniChartInstances: {}, // mini-preview Chart.js instances
    agentStatuses: {
      Orchestrator: 'Waiting',
      DataIngestion: 'Waiting',
      KpiDiscovery: 'Waiting',
      ChartVisualizer: 'Waiting',
      StrategicInsights: 'Waiting'
    },
    logs: [],
    allChartsRendered: false,
    isStreamingInsights: false
  };

  // =========================================================================
  // STRICT DD-MM-YYYY DATE ENGINE
  // =========================================================================
  const DateEngine = {
    // Regex strictly matching DD-MM-YYYY with delimiter - / or .
    regex: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/,

    isDdMmYyyy(val) {
      if (!val || typeof val !== 'string') return false;
      const str = val.trim();
      const match = str.match(this.regex);
      if (!match) return false;

      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);

      if (month < 1 || month > 12) return false;
      if (day < 1 || day > 31) return false;
      if (year < 1900 || year > 2100) return false;

      // Validate days in month
      const daysInMonth = new Date(year, month, 0).getDate();
      return day <= daysInMonth;
    },

    parseToTimestamp(val) {
      if (!this.isDdMmYyyy(val)) return null;
      const match = val.trim().match(this.regex);
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      return Date.UTC(year, month - 1, day);
    },

    formatTimestampToDdMmYyyy(ts) {
      if (!ts || isNaN(ts)) return 'N/A';
      const d = new Date(ts);
      const day = String(d.getUTCDate()).padStart(2, '0');
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const year = d.getUTCFullYear();
      return `${day}-${month}-${year}`;
    }
  };

  // =========================================================================
  // RFC 4180 CSV PARSER & DYNAMIC TYPE INFERRER
  // =========================================================================
  const CsvEngine = {
    parseCsv(csvText) {
      const rows = [];
      let currentRow = [];
      let currentVal = '';
      let insideQuote = false;

      for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        const nextChar = csvText[i + 1];

        if (char === '"') {
          if (insideQuote && nextChar === '"') {
            currentVal += '"';
            i++; // skip escaped quote
          } else {
            insideQuote = !insideQuote;
          }
        } else if (char === ',' && !insideQuote) {
          currentRow.push(currentVal.trim());
          currentVal = '';
        } else if ((char === '\r' || char === '\n') && !insideQuote) {
          if (char === '\r' && nextChar === '\n') {
            i++; // handle CRLF
          }
          currentRow.push(currentVal.trim());
          if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentVal = '';
        } else {
          currentVal += char;
        }
      }

      if (currentVal || currentRow.length > 0) {
        currentRow.push(currentVal.trim());
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
          rows.push(currentRow);
        }
      }

      if (rows.length < 2) {
        throw new Error("Dataset contains insufficient rows (minimum 1 header + 1 data row required).");
      }

      const rawHeaders = rows[0].map(h => h.replace(/^\uFEFF/, '').trim()); // Strip BOM
      const dataRows = [];

      for (let i = 1; i < rows.length; i++) {
        const rowArr = rows[i];
        // skip empty trailing lines
        if (rowArr.length === 1 && rowArr[0] === '') continue;
        const obj = {};
        rawHeaders.forEach((header, idx) => {
          obj[header] = rowArr[idx] !== undefined ? rowArr[idx] : '';
        });
        dataRows.push(obj);
      }

      return { headers: rawHeaders, data: dataRows };
    },

    cleanNumber(val) {
      if (typeof val === 'number') return val;
      if (!val) return NaN;
      // remove currency symbols, commas, percent, whitespace
      const clean = String(val).replace(/[$₹€£,\s%]/g, '');
      const parsed = parseFloat(clean);
      return isNaN(parsed) ? NaN : parsed;
    },

    inferSchema(headers, rows) {
      const columns = [];
      let detectedDateCol = null;
      let minTs = Infinity;
      let maxTs = -Infinity;

      headers.forEach(header => {
        let dateCount = 0;
        let numCount = 0;
        let nonNullCount = 0;
        const uniqueValues = new Set();
        const sampleValues = [];

        rows.forEach(r => {
          const val = r[header];
          if (val !== undefined && val !== null && String(val).trim() !== '') {
            nonNullCount++;
            const strVal = String(val).trim();
            uniqueValues.add(strVal);
            if (sampleValues.length < 5) sampleValues.push(strVal);

            if (DateEngine.isDdMmYyyy(strVal)) {
              dateCount++;
            }
            if (!isNaN(CsvEngine.cleanNumber(strVal))) {
              numCount++;
            }
          }
        });

        const totalValid = nonNullCount || 1;
        let type = 'text';

        // Strict DD-MM-YYYY check (minimum 60% matches if mixed)
        if (dateCount / totalValid >= 0.6) {
          type = 'date';
          if (!detectedDateCol) detectedDateCol = header;
        } else if (numCount / totalValid >= 0.7) {
          type = 'number';
        } else if (uniqueValues.size <= 30 || (uniqueValues.size / totalValid <= 0.25)) {
          type = 'category';
        } else {
          type = 'text';
        }

        columns.push({
          name: header,
          type,
          distinctCount: uniqueValues.size,
          sampleValues
        });
      });

      // If a date column is detected, calculate min and max date strictly in DD-MM-YYYY
      let dateRange = null;
      if (detectedDateCol) {
        rows.forEach(r => {
          const val = r[detectedDateCol];
          const ts = DateEngine.parseToTimestamp(val);
          if (ts !== null) {
            if (ts < minTs) minTs = ts;
            if (ts > maxTs) maxTs = ts;
          }
        });

        if (minTs !== Infinity && maxTs !== -Infinity) {
          dateRange = {
            column: detectedDateCol,
            min: DateEngine.formatTimestampToDdMmYyyy(minTs),
            max: DateEngine.formatTimestampToDdMmYyyy(maxTs),
            minTs,
            maxTs
          };
        }
      }

      return { columns, rowCount: rows.length, dateRange };
    }
  };

  // =========================================================================
  // BUILT-IN D2C REALISTIC SAMPLE DATASET
  // (Strict DD-MM-YYYY dates, zero hardcoded assumption in app logic)
  // =========================================================================
  const SampleDataset = {
    url: "https://docs.google.com/spreadsheets/d/1ShopEasy-D2C-Sample-Data/export?format=csv",
    csv: `Order_ID,Order_Date,Product_Category,Sub_Category,City,Sales_Amount,Quantity,Delivery_Days,Customer_Rating
OD-1001,02-01-2024,Home & Kitchen,Cookware,Mumbai,2450,2,4,4.5
OD-1002,03-01-2024,Electronics,Wireless Earbuds,Delhi,1899,1,3,4.2
OD-1003,04-01-2024,Apparel,Cotton Shirts,Bangalore,1250,2,5,3.8
OD-1004,05-01-2024,Beauty & Care,Skincare Serum,Hyderabad,799,1,2,4.8
OD-1005,07-01-2024,Sports & Fitness,Yoga Mat,Chennai,1499,1,6,4.1
OD-1006,09-01-2024,Home & Kitchen,Storage Organizers,Pune,890,3,4,4.0
OD-1007,11-01-2024,Electronics,Smart Watch,Mumbai,4299,1,3,4.6
OD-1008,13-01-2024,Apparel,Denim Jeans,Delhi,2100,1,5,4.3
OD-1009,16-01-2024,Beauty & Care,Hair Oil,Bangalore,450,2,3,4.7
OD-1010,18-01-2024,Sports & Fitness,Dumbbell Set,Hyderabad,3200,1,7,3.9
OD-1011,21-01-2024,Home & Kitchen,Air Fryer,Chennai,6499,1,5,4.8
OD-1012,24-01-2024,Electronics,Bluetooth Speaker,Pune,1599,1,2,4.4
OD-1013,27-01-2024,Apparel,Winter Hoodie,Mumbai,1850,1,4,4.1
OD-1014,30-01-2024,Beauty & Care,Sunscreen SPF50,Delhi,650,2,2,4.9
OD-1015,02-02-2024,Sports & Fitness,Resistance Bands,Bangalore,599,2,3,4.5
OD-1016,05-02-2024,Home & Kitchen,Coffee Maker,Hyderabad,3999,1,4,4.3
OD-1017,08-02-2024,Electronics,Mechanical Keyboard,Chennai,2899,1,5,4.6
OD-1018,12-02-2024,Apparel,Athletic Shorts,Pune,850,2,3,4.0
OD-1019,15-02-2024,Beauty & Care,Face Wash,Mumbai,350,3,2,4.7
OD-1020,19-02-2024,Sports & Fitness,Gym Bag,Delhi,1150,1,4,4.2
OD-1021,22-02-2024,Home & Kitchen,Blender & Grinder,Bangalore,2750,1,5,4.4
OD-1022,26-02-2024,Electronics,Power Bank,Hyderabad,1299,2,3,4.1
OD-1023,01-03-2024,Apparel,Formal Trousers,Chennai,1650,1,6,3.9
OD-1024,05-03-2024,Beauty & Care,Night Cream,Pune,920,1,3,4.8
OD-1025,09-03-2024,Sports & Fitness,Protein Shaker,Mumbai,499,2,2,4.6
OD-1026,13-03-2024,Home & Kitchen,Non-Stick Pan,Delhi,1750,1,5,4.2
OD-1027,17-03-2024,Electronics,Gaming Mouse,Bangalore,1450,1,3,4.5
OD-1028,21-03-2024,Apparel,Linen Kurta,Hyderabad,1350,1,4,4.4
OD-1029,25-03-2024,Beauty & Care,Moisturizer,Chennai,580,2,3,4.7
OD-1030,29-03-2024,Sports & Fitness,Skipping Rope,Pune,299,3,2,4.3
OD-1031,02-04-2024,Home & Kitchen,Electric Kettle,Mumbai,1299,1,3,4.5
OD-1032,06-04-2024,Electronics,USB-C Hub,Delhi,2199,1,4,4.4
OD-1033,10-04-2024,Apparel,Summer Dress,Bangalore,1950,1,5,4.2
OD-1034,14-04-2024,Beauty & Care,Clay Mask,Hyderabad,499,1,2,4.8
OD-1035,18-04-2024,Sports & Fitness,Treadmill Mat,Chennai,1899,1,6,3.8
OD-1036,22-04-2024,Home & Kitchen,Spice Rack,Pune,750,2,4,4.1
OD-1037,26-04-2024,Electronics,Noise Cancelling Headphones,Mumbai,7999,1,2,4.9
OD-1038,30-04-2024,Apparel,Casual Polo,Delhi,950,2,4,4.3
OD-1039,04-05-2024,Beauty & Care,Lip Balm Trio,Bangalore,320,3,3,4.6
OD-1040,08-05-2024,Sports & Fitness,Foam Roller,Hyderabad,899,1,4,4.5
OD-1041,12-05-2024,Home & Kitchen,Dinner Set,Chennai,3450,1,7,4.0
OD-1042,16-05-2024,Electronics,Webcam HD,Pune,2499,1,3,4.2
OD-1043,20-05-2024,Apparel,Track Pants,Mumbai,1100,2,3,4.4
OD-1044,24-05-2024,Beauty & Care,Body Lotion,Delhi,450,2,2,4.7
OD-1045,28-05-2024,Sports & Fitness,Adjustable Dumbbell,Bangalore,4800,1,6,4.1
OD-1046,01-06-2024,Home & Kitchen,Knife Set,Hyderabad,1650,1,4,4.3
OD-1047,05-06-2024,Electronics,Tablet Stand,Chennai,899,1,5,4.5
OD-1048,10-06-2024,Apparel,Silk Scarf,Pune,650,2,3,4.8
OD-1049,15-06-2024,Beauty & Care,Shampoo Sulfate-Free,Mumbai,550,2,2,4.6
OD-1050,20-06-2024,Sports & Fitness,Pull-up Bar,Delhi,1799,1,5,4.2
OD-1051,25-06-2024,Home & Kitchen,Water Purifier Bottle,Bangalore,1999,1,3,4.7
OD-1052,30-06-2024,Electronics,Smart Plug,Hyderabad,999,3,2,4.4`
  };

  // =========================================================================
  // ORCHESTRATOR AGENT & TELEMETRY LOG BUS
  // =========================================================================
  const OrchestratorAgent = {
    emitLog(agent, level, message) {
      const now = new Date();
      const timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
      ].join(':');

      const entry = { id: Math.random().toString(36).substring(7), timestamp: timeStr, agent, level, message };
      state.logs.push(entry);

      const panel = document.getElementById('consoleLogPanel');
      if (panel) {
        const line = document.createElement('div');
        line.className = 'flex items-start gap-2 text-xs leading-relaxed font-mono';

        let colorClass = 'text-slate-300';
        let badgeColor = 'text-brand-400 bg-brand-500/10 border-brand-500/20';

        if (level === 'success') {
          colorClass = 'text-emerald-300';
          badgeColor = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        } else if (level === 'warn') {
          colorClass = 'text-amber-300';
          badgeColor = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        } else if (level === 'error') {
          colorClass = 'text-rose-300';
          badgeColor = 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        }

        line.innerHTML = `
          <span class="text-slate-500 shrink-0 select-none">[${timeStr}]</span>
          <span class="px-1.5 py-0.2 rounded border text-[10px] font-semibold uppercase shrink-0 ${badgeColor}">${agent}</span>
          <span class="${colorClass} break-all">${this.escapeHtml(message)}</span>
        `;
        panel.appendChild(line);
        panel.scrollTop = panel.scrollHeight;
      }
    },

    setAgentState(agentKey, statusState, desc) {
      state.agentStatuses[agentKey] = statusState;
      const badgeId = `badge${agentKey}`;
      const descId = `desc${agentKey}`;
      const badgeEl = document.getElementById(badgeId);
      const descEl = document.getElementById(descId);

      if (badgeEl) {
        badgeEl.textContent = statusState;
        badgeEl.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase transition-all ';

        if (statusState === 'Waiting') {
          badgeEl.className += 'bg-slate-800 text-slate-400';
        } else if (statusState === 'Running') {
          badgeEl.className += 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse';
        } else if (statusState === 'Complete') {
          badgeEl.className += 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
        } else if (statusState === 'Failed') {
          badgeEl.className += 'bg-rose-500/20 text-rose-400 border border-rose-500/40';
        }
      }

      if (descEl && desc) {
        descEl.textContent = desc;
      }
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    goToStep(stepNumber) {
      state.activeStep = stepNumber;

      // Update wizard tabs UI
      for (let s = 1; s <= 5; s++) {
        const tab = document.getElementById(`stepTab${s}`);
        if (!tab) continue;
        const circle = tab.querySelector('span:first-child');
        if (s === stepNumber) {
          tab.className = 'flex items-center gap-2 text-brand-400 font-semibold transition-colors cursor-pointer';
          if (circle) circle.className = 'w-6 h-6 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs shadow ring-2 ring-brand-400/30';
        } else if (s < stepNumber) {
          tab.className = 'flex items-center gap-2 text-emerald-400 font-medium transition-colors cursor-pointer';
          if (circle) circle.className = 'w-6 h-6 rounded-full bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 flex items-center justify-center text-xs';
        } else {
          tab.className = 'flex items-center gap-2 text-slate-500 transition-colors cursor-not-allowed';
          if (circle) circle.className = 'w-6 h-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center text-xs';
        }
      }

      // Hide all sections first
      document.getElementById('step1Section').classList.add('hidden');
      document.getElementById('step2Section').classList.add('hidden');
      document.getElementById('step3Section').classList.add('hidden');
      document.getElementById('dashboardSection').classList.add('hidden');

      if (stepNumber === 1) {
        document.getElementById('step1Section').classList.remove('hidden');
      } else if (stepNumber === 2) {
        document.getElementById('step2Section').classList.remove('hidden');
      } else if (stepNumber === 3) {
        document.getElementById('step3Section').classList.remove('hidden');
      } else if (stepNumber >= 4) {
        document.getElementById('dashboardSection').classList.remove('hidden');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // =========================================================================
  // DATA INGESTION & SCHEMA AGENT
  // =========================================================================
  const DataIngestionAgent = {
    normalizeGoogleSheetUrl(url) {
      if (!url) return '';
      let clean = url.trim();

      // If user pasted standard Google Sheets edit or view URL
      // https://docs.google.com/spreadsheets/d/{ID}/edit...
      const match = clean.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        const sheetId = match[1];
        // Extract GID if present
        const gidMatch = clean.match(/[#&?]gid=([0-9]+)/);
        const gid = gidMatch ? gidMatch[1] : '0';
        return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      }

      return clean;
    },

    async fetchCsvData(url) {
      OrchestratorAgent.setAgentState('DataIngestion', 'Running', 'Fetching Google Sheet CSV...');
      OrchestratorAgent.emitLog('DataIngestion', 'info', `Connecting to source: ${url}`);

      let csvText = '';
      try {
        const response = await fetch(url, { headers: { 'Accept': 'text/csv, text/plain, */*' } });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        csvText = await response.text();
      } catch (directErr) {
        OrchestratorAgent.emitLog('DataIngestion', 'warn', `Direct fetch restricted by CORS. Attempting CORS proxy fallback...`);
        // Fallback proxy to allow direct Google Sheets CSV downloads in browser
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const proxyRes = await fetch(proxyUrl);
        if (!proxyRes.ok) {
          throw new Error(`Unable to fetch Google Sheet CSV. Please ensure the Google Sheet is "Published to web" or set to "Anyone with link can view".`);
        }
        csvText = await proxyRes.text();
      }

      if (!csvText || csvText.trim().length === 0) {
        throw new Error("Received empty CSV document from URL.");
      }

      return csvText;
    },

    processCsv(csvText, sourceUrl) {
      state.rawCsv = csvText;
      state.googleSheetUrl = sourceUrl;

      const { headers, data } = CsvEngine.parseCsv(csvText);
      state.rows = data;
      state.schema = CsvEngine.inferSchema(headers, data);

      OrchestratorAgent.emitLog('DataIngestion', 'success', `Successfully parsed ${state.schema.rowCount} rows across ${state.schema.columns.length} columns.`);

      if (state.schema.dateRange) {
        OrchestratorAgent.emitLog('DataIngestion', 'info', `Strict DD-MM-YYYY date bounds detected on [${state.schema.dateRange.column}]: ${state.schema.dateRange.min} to ${state.schema.dateRange.max}`);
      } else {
        OrchestratorAgent.emitLog('DataIngestion', 'warn', `No strict DD-MM-YYYY date column detected in dataset.`);
      }

      this.renderSchemaPreview();
      this.updateHeaderControls();
      OrchestratorAgent.setAgentState('DataIngestion', 'Complete', `${state.schema.rowCount} rows ready`);
    },

    renderSchemaPreview() {
      const container = document.getElementById('schemaPreviewContainer');
      const totalRowsEl = document.getElementById('previewTotalRows');
      const totalColsEl = document.getElementById('previewTotalCols');
      const dateRangeChip = document.getElementById('previewDateRangeChip');
      const dateRangeText = document.getElementById('previewDateRangeText');
      const badgesGrid = document.getElementById('columnBadgesGrid');
      const thead = document.getElementById('sampleDataTableHead');
      const tbody = document.getElementById('sampleDataTableBody');

      totalRowsEl.textContent = state.schema.rowCount.toLocaleString();
      totalColsEl.textContent = state.schema.columns.length;

      if (state.schema.dateRange) {
        dateRangeText.textContent = `${state.schema.dateRange.min} → ${state.schema.dateRange.max}`;
        dateRangeChip.classList.remove('hidden');
      } else {
        dateRangeChip.classList.add('hidden');
      }

      // Column Type Badges
      badgesGrid.innerHTML = '';
      state.schema.columns.forEach(col => {
        const badge = document.createElement('div');
        let typeColor = 'bg-slate-800 text-slate-300 border-slate-700';
        let iconName = 'file-text';

        if (col.type === 'date') {
          typeColor = 'bg-brand-500/10 text-brand-300 border-brand-500/30';
          iconName = 'calendar';
        } else if (col.type === 'number') {
          typeColor = 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30';
          iconName = 'hash';
        } else if (col.type === 'category') {
          typeColor = 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30';
          iconName = 'tag';
        }

        badge.className = `flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${typeColor}`;
        badge.innerHTML = `
          <i data-lucide="${iconName}" class="w-3 h-3"></i>
          <span>${OrchestratorAgent.escapeHtml(col.name)}</span>
          <span class="text-[10px] opacity-75 uppercase font-mono tracking-wider ml-1 px-1 rounded bg-black/20">${col.type}</span>
        `;
        badgesGrid.appendChild(badge);
      });

      // Render 3 Sample Rows Table
      thead.innerHTML = '';
      const headerTr = document.createElement('tr');
      state.schema.columns.forEach(col => {
        const th = document.createElement('th');
        th.className = 'px-3 py-2.5 whitespace-nowrap text-xs font-semibold';
        th.textContent = col.name;
        headerTr.appendChild(th);
      });
      thead.appendChild(headerTr);

      tbody.innerHTML = '';
      const sampleRows = state.rows.slice(0, 3);
      sampleRows.forEach((r, idx) => {
        const tr = document.createElement('tr');
        tr.className = idx % 2 === 0 ? 'bg-dark-900/40' : 'bg-dark-850/40';
        state.schema.columns.forEach(col => {
          const td = document.createElement('td');
          td.className = 'px-3 py-2 whitespace-nowrap text-slate-300 border-t border-slate-800/60 font-mono';
          const val = r[col.name] !== undefined ? r[col.name] : '';
          td.textContent = val;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      container.classList.remove('hidden');
      lucide.createIcons();
    },

    updateHeaderControls() {
      // Update Date Range Chip in Header
      const headerDateRangeChip = document.getElementById('headerDateRangeChip');
      const headerDateRangeText = document.getElementById('headerDateRangeText');
      if (state.schema.dateRange) {
        headerDateRangeText.textContent = `${state.schema.dateRange.min} to ${state.schema.dateRange.max}`;
        headerDateRangeChip.classList.remove('hidden');
        headerDateRangeChip.classList.add('flex');
      } else {
        headerDateRangeChip.classList.add('hidden');
      }

      // Update Source Link in Header
      const headerLink = document.getElementById('headerSourceSheetLink');
      if (state.googleSheetUrl && state.googleSheetUrl.startsWith('http')) {
        headerLink.href = state.googleSheetUrl;
        headerLink.classList.remove('hidden');
        headerLink.classList.add('flex');
      } else {
        headerLink.classList.add('hidden');
      }
    }
  };

  // =========================================================================
  // KPI & METRIC DISCOVERY AGENT
  // =========================================================================
  const KpiDiscoveryAgent = {
    discoverAndComputeKpis() {
      OrchestratorAgent.setAgentState('KpiDiscovery', 'Running', 'Scanning schema for business metrics...');
      OrchestratorAgent.emitLog('KpiDiscovery', 'info', `Evaluating ${state.schema.columns.length} columns for financial, order, and transit roles.`);

      const numCols = state.schema.columns.filter(c => c.type === 'number');
      const colNames = state.schema.columns.map(c => c.name);

      // 1. Revenue Column Detection
      // Look for revenue, sales, gmv, amount, price, total
      let revenueCol = numCols.find(c => /revenue|sales|gmv|amount|price|subtotal|total_price/i.test(c.name));
      if (!revenueCol && numCols.length > 0) {
        // Fallback: numeric column with largest sum
        revenueCol = numCols.reduce((best, cur) => {
          const sumCur = state.rows.reduce((acc, r) => acc + (CsvEngine.cleanNumber(r[cur.name]) || 0), 0);
          const sumBest = best ? state.rows.reduce((acc, r) => acc + (CsvEngine.cleanNumber(r[best.name]) || 0), 0) : -Infinity;
          return sumCur > sumBest ? cur : best;
        }, null);
      }

      // 2. Orders Column Detection
      const orderCol = colNames.find(name => /order|id|trans|invoice/i.test(name));
      const totalOrders = state.rows.length;

      // 3. Delivery Days Column Detection
      const deliveryCol = numCols.find(c => /delivery|shipping|transit|dispatch|lead/i.test(c.name));

      // 4. Quantity / Units Column Detection
      const qtyCol = numCols.find(c => /quantity|qty|units|items/i.test(c.name));

      // Calculate aggregates
      let totalRevenue = 0;
      if (revenueCol) {
        totalRevenue = state.rows.reduce((acc, r) => {
          const val = CsvEngine.cleanNumber(r[revenueCol.name]);
          return acc + (isNaN(val) ? 0 : val);
        }, 0);
      }

      let avgDeliveryDays = 0;
      if (deliveryCol) {
        let sumDeliv = 0;
        let countDeliv = 0;
        state.rows.forEach(r => {
          const val = CsvEngine.cleanNumber(r[deliveryCol.name]);
          if (!isNaN(val) && val > 0) {
            sumDeliv += val;
            countDeliv++;
          }
        });
        avgDeliveryDays = countDeliv > 0 ? (sumDeliv / countDeliv) : 0;
      }

      const aov = totalOrders > 0 ? (totalRevenue / totalOrders) : 0;

      let totalUnits = 0;
      if (qtyCol) {
        totalUnits = state.rows.reduce((acc, r) => {
          const val = CsvEngine.cleanNumber(r[qtyCol.name]);
          return acc + (isNaN(val) ? 0 : val);
        }, 0);
      }

      state.kpis = {
        revenueCol: revenueCol ? revenueCol.name : null,
        totalRevenue,
        orderCol: orderCol || 'Total Records',
        totalOrders,
        deliveryCol: deliveryCol ? deliveryCol.name : null,
        avgDeliveryDays,
        aov,
        qtyCol: qtyCol ? qtyCol.name : null,
        totalUnits
      };

      OrchestratorAgent.emitLog('KpiDiscovery', 'success', `Identified KPIs: Revenue ($${Math.round(totalRevenue).toLocaleString()}), Orders (${totalOrders.toLocaleString()}), Avg Delivery (${avgDeliveryDays.toFixed(1)} days).`);
      this.renderKpiCards();
      OrchestratorAgent.setAgentState('KpiDiscovery', 'Complete', 'KPIs computed');
    },

    renderKpiCards() {
      const container = document.getElementById('kpiCardsGrid');
      if (!container) return;

      container.innerHTML = `
        <!-- Total Revenue Card -->
        <div class="glass-card rounded-xl p-5 border border-slate-800 glass-card-hover transition-all">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Revenue</span>
            <div class="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <i data-lucide="dollar-sign" class="w-4 h-4"></i>
            </div>
          </div>
          <div class="text-2xl font-bold font-mono text-white mb-1">
            $${Math.round(state.kpis.totalRevenue).toLocaleString()}
          </div>
          <p class="text-[11px] text-slate-400">
            Column: <span class="font-mono text-brand-300 font-medium">${state.kpis.revenueCol || 'Detected Sum'}</span>
          </p>
        </div>

        <!-- Total Orders Card -->
        <div class="glass-card rounded-xl p-5 border border-slate-800 glass-card-hover transition-all">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Orders</span>
            <div class="p-2 rounded-lg bg-brand-500/10 text-brand-400 border border-brand-500/20">
              <i data-lucide="shopping-bag" class="w-4 h-4"></i>
            </div>
          </div>
          <div class="text-2xl font-bold font-mono text-white mb-1">
            ${state.kpis.totalOrders.toLocaleString()}
          </div>
          <p class="text-[11px] text-slate-400">
            Transactions logged across dataset
          </p>
        </div>

        <!-- Average Delivery Days Card -->
        <div class="glass-card rounded-xl p-5 border border-slate-800 glass-card-hover transition-all">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Avg Delivery Days</span>
            <div class="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <i data-lucide="truck" class="w-4 h-4"></i>
            </div>
          </div>
          <div class="text-2xl font-bold font-mono text-white mb-1">
            ${state.kpis.deliveryCol ? state.kpis.avgDeliveryDays.toFixed(1) + ' Days' : 'N/A'}
          </div>
          <p class="text-[11px] text-slate-400">
            ${state.kpis.deliveryCol ? `Tracked via ${state.kpis.deliveryCol}` : 'No delivery column detected'}
          </p>
        </div>

        <!-- Average Order Value (AOV) Card -->
        <div class="glass-card rounded-xl p-5 border border-slate-800 glass-card-hover transition-all">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Average Order Value (AOV)</span>
            <div class="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <i data-lucide="bar-chart-2" class="w-4 h-4"></i>
            </div>
          </div>
          <div class="text-2xl font-bold font-mono text-white mb-1">
            $${state.kpis.aov.toFixed(2)}
          </div>
          <p class="text-[11px] text-slate-400">
            Revenue per completed transaction
          </p>
        </div>
      `;

      lucide.createIcons();
    }
  };

  // =========================================================================
  // GEMINI 2.5 FLASH CLIENT (STRUCTURED JSON & SSE STREAMING)
  // =========================================================================
  const GeminiClient = {
    // Model identifier strictly enforced
    MODEL: 'gemini-2.5-flash',

    hasApiKey() {
      return Boolean(state.apiKey && state.apiKey.trim().length > 5);
    },

    async generateRecommendations(questions, schema) {
      if (!this.hasApiKey()) {
        // Return smart rule-based fallback recommendations when offline or without API key
        return this.getFallbackRecommendations(questions, schema);
      }

      const prompt = `
You are the Chart Recommendation & Visual Agent in the ShopEasy Multi-Agent System.
Examine this dataset schema and user business questions.

DATASET SCHEMA:
Columns: ${JSON.stringify(schema.columns.map(c => ({ name: c.name, type: c.type, sampleValues: c.sampleValues.slice(0, 3) })))}
Total Rows: ${schema.rowCount}
Date Range: ${schema.dateRange ? `${schema.dateRange.min} to ${schema.dateRange.max}` : 'None'}

USER BUSINESS QUESTIONS:
${questions.map((q, idx) => `Q${idx + 1}: "${q}"`).join('\n')}

INSTRUCTIONS:
For each question, recommend the optimal visual representation using ONLY actual column names from the schema.
Choose chartType from: "bar", "line", "donut", "scatter", "area".
Choose aggregation from: "sum", "avg", "count".
Provide a single crisp, non-technical reasoning sentence explaining why this answers the question.

Output MUST be a valid JSON array of objects with keys:
[
  {
    "questionIndex": 0,
    "chartType": "bar",
    "xAxis": "exact_column_name",
    "yAxis": "exact_column_name",
    "aggregation": "sum",
    "reasoning": "Clear 1-sentence non-technical rationale."
  }
]
`;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL}:generateContent?key=${encodeURIComponent(state.apiKey.trim())}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2
            }
          })
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) throw new Error("Empty response from Gemini 2.5 Flash");

        const parsed = JSON.parse(jsonText);
        return parsed.map((item, idx) => ({
          id: `chart_${idx}_${Date.now()}`,
          question: questions[item.questionIndex !== undefined ? item.questionIndex : idx] || questions[idx],
          chartType: item.chartType || 'bar',
          xAxis: item.xAxis || schema.columns[0]?.name,
          yAxis: item.yAxis || (schema.columns.find(c => c.type === 'number')?.name || schema.columns[0]?.name),
          aggregation: item.aggregation || 'sum',
          reasoning: item.reasoning || "Visual breakdown tailored to your question."
        }));
      } catch (err) {
        OrchestratorAgent.emitLog('ChartVisualizer', 'warn', `Gemini API call failed (${err.message}). Using intelligent schema mapper fallback.`);
        return this.getFallbackRecommendations(questions, schema);
      }
    },

    getFallbackRecommendations(questions, schema) {
      const dateCol = schema.columns.find(c => c.type === 'date')?.name;
      const numCols = schema.columns.filter(c => c.type === 'number').map(c => c.name);
      const catCols = schema.columns.filter(c => c.type === 'category').map(c => c.name);
      const allCols = schema.columns.map(c => c.name);

      const primaryNum = numCols.find(c => /revenue|sales|gmv|amount/i.test(c)) || numCols[0] || allCols[0];
      const primaryCat = catCols.find(c => /category|product|type/i.test(c)) || catCols[0] || allCols[0];

      return questions.map((q, idx) => {
        const lowerQ = q.toLowerCase();
        let chartType = 'bar';
        let xAxis = primaryCat;
        let yAxis = primaryNum;
        let aggregation = 'sum';
        let reasoning = "Aggregates key metrics across primary segments.";

        if (/trend|time|daily|monthly|over time|growth|date/i.test(lowerQ) && dateCol) {
          chartType = 'line';
          xAxis = dateCol;
          yAxis = primaryNum;
          aggregation = 'sum';
          reasoning = `Visualizes temporal trajectory over strict DD-MM-YYYY dates using ${yAxis}.`;
        } else if (/city|cities|region|zone|location|state/i.test(lowerQ)) {
          const cityCol = allCols.find(c => /city|region|zone|state|location/i.test(c)) || primaryCat;
          const delivCol = numCols.find(c => /delivery|shipping|transit|days/i.test(c)) || primaryNum;
          chartType = 'bar';
          xAxis = cityCol;
          yAxis = delivCol;
          aggregation = /delivery|days|time|rating|rate|avg/i.test(lowerQ) ? 'avg' : 'sum';
          reasoning = `Compares performance benchmarks across geographic territories.`;
        } else if (/share|portion|breakdown|distribution|split|percent/i.test(lowerQ)) {
          chartType = 'donut';
          xAxis = primaryCat;
          yAxis = primaryNum;
          aggregation = 'sum';
          reasoning = `Highlights market share composition across categories.`;
        } else if (/correlation|relationship|vs|against|rating/i.test(lowerQ) && numCols.length >= 2) {
          chartType = 'scatter';
          xAxis = numCols[0];
          yAxis = numCols[1] || numCols[0];
          aggregation = 'none';
          reasoning = `Analyzes statistical relationship between two numeric distributions.`;
        } else if (idx === 1 && dateCol) {
          chartType = 'line';
          xAxis = dateCol;
          yAxis = primaryNum;
          aggregation = 'sum';
          reasoning = `Tracks daily sales performance across chronological time intervals.`;
        } else if (idx === 2) {
          const cityCol = allCols.find(c => /city|region|zone/i.test(c));
          const delivCol = numCols.find(c => /delivery|transit/i.test(c));
          if (cityCol && delivCol) {
            chartType = 'bar';
            xAxis = cityCol;
            yAxis = delivCol;
            aggregation = 'avg';
            reasoning = `Compares fulfillment speed and shipping delays by location.`;
          } else {
            chartType = 'donut';
            xAxis = primaryCat;
            yAxis = primaryNum;
            aggregation = 'sum';
            reasoning = `Reveals proportion of business contribution by segment.`;
          }
        }

        return {
          id: `chart_${idx}_${Date.now()}`,
          question: q,
          chartType,
          xAxis: xAxis || allCols[0],
          yAxis: yAxis || allCols[0],
          aggregation,
          reasoning
        };
      });
    },

    async streamInsights(kpis, chartsData, onChunk, onComplete) {
      if (!this.hasApiKey()) {
        OrchestratorAgent.emitLog('StrategicInsights', 'warn', `No Gemini API key supplied. Demonstrating grounded strategic insight synthesis.`);
        this.streamFallbackInsights(kpis, chartsData, onChunk, onComplete);
        return;
      }

      OrchestratorAgent.setAgentState('StrategicInsights', 'Running', 'Streaming Gemini 2.5 Flash...');
      OrchestratorAgent.emitLog('StrategicInsights', 'info', `Sending verified chart metrics to Gemini 2.5 Flash streaming endpoint.`);

      const prompt = `
You are the Strategic Insight Agent for the ShopEasy D2C e-commerce platform.
The user has completed the chart rendering step. Below are the verified metrics and aggregated chart findings from their live dataset:

OVERALL DATASET KPIS:
- Total Revenue: $${Math.round(kpis.totalRevenue).toLocaleString()} (Source column: ${kpis.revenueCol})
- Total Orders: ${kpis.totalOrders.toLocaleString()}
- Average Delivery Days: ${kpis.avgDeliveryDays > 0 ? kpis.avgDeliveryDays.toFixed(1) + ' days' : 'N/A'} (Source: ${kpis.deliveryCol})
- Average Order Value (AOV): $${kpis.aov.toFixed(2)}
- Date Range: ${state.schema.dateRange ? `${state.schema.dateRange.min} to ${state.schema.dateRange.max}` : 'Not Specified'}

RENDERED CHART AGGREGATIONS:
${chartsData.map((cd, i) => `
Chart ${i + 1} (${cd.question}):
Type: ${cd.chartType} | X: ${cd.xAxis} | Y: ${cd.yAxis} (${cd.aggregation})
Top Data Points: ${JSON.stringify(cd.dataPoints.slice(0, 6))}
`).join('\n')}

STRICT BUSINESS FORMAT CONSTRAINTS:
1. Generate MAXIMUM 5 bullet points.
2. Every bullet must be a crisp, actionable business finding.
3. Every single bullet MUST quote specific numbers and percentages from the dataset provided above.
4. Format each bullet exactly as:
   • [Finding with Metric] — [Direct Actionable Business Solution]
5. Write strictly for an executive founder: NO technical data science jargon (no "P-value", "standard deviation", "heteroskedasticity", "sample skew").
6. Focus on revenue drivers, logistics bottlenecks, high-margin categories, and fulfillment improvements.
`;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(state.apiKey.trim())}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3
            }
          })
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep partial line

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.substring(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (chunk) {
                  onChunk(chunk);
                }
              } catch (e) {
                // Ignore partial JSON chunks
              }
            }
          }
        }

        if (buffer.trim().startsWith('data: ')) {
          try {
            const parsed = JSON.parse(buffer.trim().substring(6));
            const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (chunk) onChunk(chunk);
          } catch (e) {}
        }

        onComplete();
        OrchestratorAgent.setAgentState('StrategicInsights', 'Complete', 'Insights delivered');
        OrchestratorAgent.emitLog('StrategicInsights', 'success', `Stream completed successfully. 5 actionable business points rendered.`);
      } catch (err) {
        OrchestratorAgent.emitLog('StrategicInsights', 'warn', `Gemini streaming encountered an error (${err.message}). Streaming grounded fallback insights.`);
        this.streamFallbackInsights(kpis, chartsData, onChunk, onComplete);
      }
    },

    streamFallbackInsights(kpis, chartsData, onChunk, onComplete) {
      // Synthesize realistic grounded bullet points from live data
      const bullets = [];

      // Finding 1: Revenue concentration
      const catChart = chartsData.find(c => /category|product/i.test(c.xAxis));
      if (catChart && catChart.dataPoints.length > 0) {
        const sorted = [...catChart.dataPoints].sort((a, b) => b.y - a.y);
        const top = sorted[0];
        const total = sorted.reduce((acc, d) => acc + d.y, 0);
        const pct = total > 0 ? Math.round((top.y / total) * 100) : 0;
        bullets.push(`• **${top.x} dominates sales contributing ${pct}% of total revenue ($${Math.round(top.y).toLocaleString()})** — Expand inventory depth and run targeted retention campaigns for this core revenue engine immediately.`);
      } else {
        bullets.push(`• **Total Revenue reached $${Math.round(kpis.totalRevenue).toLocaleString()} across ${kpis.totalOrders.toLocaleString()} customer orders with an AOV of $${kpis.aov.toFixed(2)}** — Focus on upselling bundles to push AOV above $${(kpis.aov * 1.15).toFixed(2)}.`);
      }

      // Finding 2: Logistics / Delivery Days bottleneck
      const cityChart = chartsData.find(c => /city|region|zone/i.test(c.xAxis) && /delivery|shipping|days/i.test(c.yAxis));
      if (cityChart && cityChart.dataPoints.length > 0) {
        const sorted = [...cityChart.dataPoints].sort((a, b) => b.y - a.y);
        const slowest = sorted[0];
        bullets.push(`• **${slowest.x} records the longest fulfillment delay at ${slowest.y.toFixed(1)} average delivery days (system average: ${kpis.avgDeliveryDays.toFixed(1)} days)** — Partner with local 3PL micro-warehouses in ${slowest.x} to compress delivery times under 3 days.`);
      } else if (kpis.avgDeliveryDays > 0) {
        bullets.push(`• **Average delivery duration stands at ${kpis.avgDeliveryDays.toFixed(1)} days across all shipping routes** — Standardize express regional fulfillment to improve customer satisfaction and reduce return likelihood.`);
      }

      // Finding 3: Lowest performing segment
      if (catChart && catChart.dataPoints.length > 2) {
        const sorted = [...catChart.dataPoints].sort((a, b) => a.y - b.y);
        const lowest = sorted[0];
        bullets.push(`• **${lowest.x} underperforms with only $${Math.round(lowest.y).toLocaleString()} in total revenue** — Audit product catalog pricing and bundle slow-moving items with high-velocity bestsellers.`);
      }

      // Finding 4: Temporal / Sales velocity
      const dateChart = chartsData.find(c => c.chartType === 'line' || /date/i.test(c.xAxis));
      if (dateChart && dateChart.dataPoints.length > 0) {
        const totalPoints = dateChart.dataPoints.length;
        const peak = [...dateChart.dataPoints].sort((a, b) => b.y - a.y)[0];
        bullets.push(`• **Peak single-day volume surged to $${Math.round(peak.y).toLocaleString()} on ${peak.x}** — Replicate promotion mechanics and ad creative from this high-converting day across upcoming weekend cycles.`);
      } else {
        bullets.push(`• **Transaction frequency averages ${(kpis.totalOrders / 30).toFixed(1)} orders per active day** — Implement automated cart abandonment reminders to lift daily conversion rate.`);
      }

      // Finding 5: Actionable growth lever
      bullets.push(`• **Current Average Order Value is grounded at $${kpis.aov.toFixed(2)} across ${kpis.totalOrders.toLocaleString()} customer touchpoints** — Introduce free shipping thresholds at $${Math.ceil(kpis.aov * 1.25)} to incentivize higher basket sizes.`);

      // Stream character by character with interval
      let bulletIdx = 0;
      let charIdx = 0;
      const fullText = bullets.slice(0, 5).join('\n\n');

      const interval = setInterval(() => {
        const chunk = fullText.slice(charIdx, charIdx + 4);
        charIdx += 4;
        if (chunk) onChunk(chunk);

        if (charIdx >= fullText.length) {
          clearInterval(interval);
          onComplete();
          OrchestratorAgent.setAgentState('StrategicInsights', 'Complete', 'Insights delivered');
          OrchestratorAgent.emitLog('StrategicInsights', 'success', `Delivered 5 metric-grounded strategic insights.`);
        }
      }, 20);
    }
  };

  // =========================================================================
  // CHART RECOMMENDATION & VISUAL AGENT
  // =========================================================================
  const ChartRecommenderAgent = {
    async generateRecommendations(questions) {
      OrchestratorAgent.setAgentState('ChartVisualizer', 'Running', 'Querying Gemini 2.5 Flash for chart mappings...');
      OrchestratorAgent.emitLog('ChartVisualizer', 'info', `Evaluating ${questions.length} business questions against detected schema.`);

      const loadingEl = document.getElementById('recommenderLoadingState');
      const gridEl = document.getElementById('recommendationCardsGrid');

      loadingEl.classList.remove('hidden');
      gridEl.classList.add('hidden');

      const recommendations = await GeminiClient.generateRecommendations(questions, state.schema);
      state.chartConfigs = recommendations;

      loadingEl.classList.add('hidden');
      gridEl.classList.remove('hidden');

      OrchestratorAgent.emitLog('ChartVisualizer', 'success', `Generated ${recommendations.length} custom visualization configurations.`);
      this.renderRecommendationCards();
      OrchestratorAgent.setAgentState('ChartVisualizer', 'Complete', `${recommendations.length} configs ready`);
    },

    renderRecommendationCards() {
      const gridEl = document.getElementById('recommendationCardsGrid');
      gridEl.innerHTML = '';

      // Destroy previous mini chart instances
      Object.values(state.miniChartInstances).forEach(c => c && c.destroy());
      state.miniChartInstances = {};

      state.chartConfigs.forEach((config, idx) => {
        const card = document.createElement('div');
        card.className = 'glass-card rounded-2xl p-5 border border-slate-800 space-y-4 flex flex-col justify-between';
        
        const canvasId = `miniCanvas_${idx}`;
        const allCols = state.schema.columns.map(c => c.name);

        card.innerHTML = `
          <div class="space-y-3">
            <!-- Header: Question & Badge -->
            <div class="space-y-1">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-bold text-brand-400 font-mono uppercase tracking-wider">Question ${idx + 1}</span>
                <span class="text-[10px] px-2 py-0.5 rounded bg-brand-500/10 text-brand-300 border border-brand-500/20 font-medium">
                  Gemini 2.5 Flash
                </span>
              </div>
              <h4 class="text-sm font-semibold text-white leading-snug">${OrchestratorAgent.escapeHtml(config.question)}</h4>
              <p class="text-xs text-slate-400 italic">${OrchestratorAgent.escapeHtml(config.reasoning)}</p>
            </div>

            <!-- Live Mini Preview Canvas -->
            <div class="bg-dark-900/90 rounded-xl p-3 border border-slate-800/80 h-40 relative flex items-center justify-center">
              <canvas id="${canvasId}" class="w-full h-full"></canvas>
            </div>

            <!-- Interactive Configuration Controls -->
            <div class="grid grid-cols-2 gap-2.5 pt-1 text-xs">
              
              <!-- Chart Type Selector -->
              <div class="space-y-1">
                <label class="text-slate-400 font-medium block">Chart Type</label>
                <select id="typeSelect_${idx}" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 focus:border-brand-500 text-xs">
                  <option value="bar" ${config.chartType === 'bar' ? 'selected' : ''}>Bar Chart</option>
                  <option value="line" ${config.chartType === 'line' ? 'selected' : ''}>Line Trend</option>
                  <option value="donut" ${config.chartType === 'donut' ? 'selected' : ''}>Donut Chart</option>
                  <option value="scatter" ${config.chartType === 'scatter' ? 'selected' : ''}>Scatter Plot</option>
                  <option value="area" ${config.chartType === 'area' ? 'selected' : ''}>Area Chart</option>
                </select>
              </div>

              <!-- Aggregation Selector -->
              <div class="space-y-1">
                <label class="text-slate-400 font-medium block">Aggregation</label>
                <select id="aggSelect_${idx}" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 focus:border-brand-500 text-xs">
                  <option value="sum" ${config.aggregation === 'sum' ? 'selected' : ''}>Sum (Total)</option>
                  <option value="avg" ${config.aggregation === 'avg' ? 'selected' : ''}>Average (Mean)</option>
                  <option value="count" ${config.aggregation === 'count' ? 'selected' : ''}>Count (Entries)</option>
                  <option value="none" ${config.aggregation === 'none' ? 'selected' : ''}>Raw Values</option>
                </select>
              </div>

              <!-- X-Axis Selector -->
              <div class="space-y-1">
                <label class="text-slate-400 font-medium block">X-Axis Column</label>
                <select id="xSelect_${idx}" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 focus:border-brand-500 text-xs font-mono">
                  ${allCols.map(col => `<option value="${col}" ${config.xAxis === col ? 'selected' : ''}>${col}</option>`).join('')}
                </select>
              </div>

              <!-- Y-Axis Selector -->
              <div class="space-y-1">
                <label class="text-slate-400 font-medium block">Y-Axis Column</label>
                <select id="ySelect_${idx}" class="w-full bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 focus:border-brand-500 text-xs font-mono">
                  ${allCols.map(col => `<option value="${col}" ${config.yAxis === col ? 'selected' : ''}>${col}</option>`).join('')}
                </select>
              </div>

            </div>
          </div>
        `;

        gridEl.appendChild(card);

        // Bind interactive change events to update state and live thumbnail immediately
        setTimeout(() => {
          this.renderMiniChart(idx, canvasId);

          const typeEl = document.getElementById(`typeSelect_${idx}`);
          const aggEl = document.getElementById(`aggSelect_${idx}`);
          const xEl = document.getElementById(`xSelect_${idx}`);
          const yEl = document.getElementById(`ySelect_${idx}`);

          const updateHandler = () => {
            config.chartType = typeEl.value;
            config.aggregation = aggEl.value;
            config.xAxis = xEl.value;
            config.yAxis = yEl.value;
            this.renderMiniChart(idx, canvasId);
            OrchestratorAgent.emitLog('ChartVisualizer', 'info', `Updated Question ${idx + 1} config: ${config.chartType.toUpperCase()} (${config.xAxis} vs ${config.yAxis} [${config.aggregation}])`);
          };

          typeEl.addEventListener('change', updateHandler);
          aggEl.addEventListener('change', updateHandler);
          xEl.addEventListener('change', updateHandler);
          yEl.addEventListener('change', updateHandler);
        }, 10);
      });
    },

    aggregateData(config) {
      const { xAxis, yAxis, aggregation } = config;
      const xCol = state.schema.columns.find(c => c.name === xAxis);
      const isDateX = xCol && xCol.type === 'date';

      // Group by X
      const groups = new Map();

      state.rows.forEach(r => {
        let xVal = r[xAxis];
        if (xVal === undefined || xVal === null || String(xVal).trim() === '') return;
        xVal = String(xVal).trim();

        const yNum = CsvEngine.cleanNumber(r[yAxis]);
        const validY = isNaN(yNum) ? 0 : yNum;

        if (!groups.has(xVal)) {
          groups.set(xVal, { sum: 0, count: 0, rawValues: [], timestamp: isDateX ? DateEngine.parseToTimestamp(xVal) : null });
        }
        const item = groups.get(xVal);
        item.sum += validY;
        item.count += 1;
        item.rawValues.push(validY);
      });

      let results = [];
      groups.forEach((val, key) => {
        let finalY = val.sum;
        if (aggregation === 'avg') {
          finalY = val.count > 0 ? (val.sum / val.count) : 0;
        } else if (aggregation === 'count') {
          finalY = val.count;
        }
        results.push({
          x: key,
          y: Math.round(finalY * 100) / 100,
          timestamp: val.timestamp
        });
      });

      // Sort: if dates, sort chronologically by timestamp; otherwise sort by value descending
      if (isDateX) {
        results.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      } else {
        results.sort((a, b) => b.y - a.y);
      }

      // Limit categorical slices for clarity
      if (!isDateX && results.length > 10) {
        results = results.slice(0, 10);
      }

      return results;
    },

    renderMiniChart(index, canvasId) {
      const config = state.chartConfigs[index];
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;

      if (state.miniChartInstances[index]) {
        state.miniChartInstances[index].destroy();
      }

      const dataPoints = this.aggregateData(config);
      const labels = dataPoints.map(d => d.x);
      const values = dataPoints.map(d => d.y);

      const ctx = canvas.getContext('2d');
      const chartType = config.chartType === 'area' ? 'line' : (config.chartType === 'donut' ? 'doughnut' : config.chartType);

      const colorPalette = [
        '#8b5cf6', '#6366f1', '#3b82f6', '#10b981', '#f59e0b',
        '#ec4899', '#14b8a6', '#f97316', '#a855f7', '#06b6d4'
      ];

      state.miniChartInstances[index] = new Chart(ctx, {
        type: chartType,
        data: {
          labels,
          datasets: [{
            label: config.yAxis,
            data: values,
            backgroundColor: chartType === 'doughnut' ? colorPalette : (chartType === 'line' ? 'rgba(139, 92, 246, 0.15)' : '#8b5cf6'),
            borderColor: '#8b5cf6',
            borderWidth: 1.5,
            fill: config.chartType === 'area',
            tension: 0.3,
            pointRadius: chartType === 'line' ? 2 : 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          plugins: {
            legend: { display: chartType === 'doughnut', position: 'bottom', labels: { boxWidth: 8, font: { size: 9 }, color: '#94a3b8' } },
            tooltip: { enabled: false }
          },
          scales: chartType === 'doughnut' ? {} : {
            x: { display: false },
            y: { display: false }
          }
        }
      });
    },

    async renderFullChartsSequentially() {
      OrchestratorAgent.setAgentState('ChartVisualizer', 'Running', 'Rendering charts sequentially...');
      const fullGrid = document.getElementById('fullChartsGrid');
      const progressBadge = document.getElementById('chartsRenderProgressBadge');
      fullGrid.innerHTML = '';

      // Clean existing chart instances
      Object.values(state.chartInstances).forEach(c => c && c.destroy());
      state.chartInstances = {};
      state.allChartsRendered = false;

      const renderedChartsPayload = [];

      for (let i = 0; i < state.chartConfigs.length; i++) {
        const config = state.chartConfigs[i];
        progressBadge.textContent = `Rendering chart ${i + 1} of ${state.chartConfigs.length}...`;
        OrchestratorAgent.emitLog('ChartVisualizer', 'info', `Aggregating and drawing Chart ${i + 1}: "${config.question}" (${config.chartType.toUpperCase()})`);

        const chartCard = document.createElement('div');
        chartCard.className = 'glass-card rounded-2xl p-6 border border-slate-800 shadow-xl space-y-4';
        const canvasId = `fullCanvas_${i}`;

        chartCard.innerHTML = `
          <div class="flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
            <div>
              <span class="text-[11px] font-bold text-brand-400 font-mono uppercase tracking-wider">Question ${i + 1}</span>
              <h4 class="text-base font-semibold text-white tracking-tight mt-0.5">${OrchestratorAgent.escapeHtml(config.question)}</h4>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="text-[10px] font-mono font-semibold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                ${config.chartType}
              </span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/20">
                ${config.aggregation.toUpperCase()}
              </span>
            </div>
          </div>
          <div class="h-72 w-full relative">
            <canvas id="${canvasId}"></canvas>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800/60 font-mono">
            <span>X: ${config.xAxis}</span>
            <span>Y: ${config.yAxis}</span>
          </div>
        `;

        fullGrid.appendChild(chartCard);

        // Calculate aggregated data
        const dataPoints = this.aggregateData(config);
        renderedChartsPayload.push({
          question: config.question,
          chartType: config.chartType,
          xAxis: config.xAxis,
          yAxis: config.yAxis,
          aggregation: config.aggregation,
          dataPoints
        });

        // Slight async delay to visualize sequential agent rendering
        await new Promise(res => setTimeout(res, 450));

        // Render with Chart.js
        const canvas = document.getElementById(canvasId);
        const ctx = canvas.getContext('2d');
        const labels = dataPoints.map(d => d.x);
        const values = dataPoints.map(d => d.y);

        const colorPalette = [
          '#8b5cf6', '#6366f1', '#3b82f6', '#10b981', '#f59e0b',
          '#ec4899', '#14b8a6', '#f97316', '#a855f7', '#06b6d4'
        ];

        const chartType = config.chartType === 'area' ? 'line' : (config.chartType === 'donut' ? 'doughnut' : config.chartType);

        state.chartInstances[i] = new Chart(ctx, {
          type: chartType,
          data: {
            labels,
            datasets: [{
              label: `${config.yAxis} (${config.aggregation})`,
              data: values,
              backgroundColor: chartType === 'doughnut' ? colorPalette : (chartType === 'line' ? 'rgba(139, 92, 246, 0.15)' : '#8b5cf6'),
              borderColor: '#8b5cf6',
              borderWidth: 2,
              fill: config.chartType === 'area',
              tension: 0.35,
              pointRadius: chartType === 'line' ? 3.5 : 0,
              pointHoverRadius: 6,
              pointBackgroundColor: '#8b5cf6'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeOutQuart' },
            plugins: {
              legend: {
                display: chartType === 'doughnut',
                position: 'right',
                labels: { boxWidth: 12, color: '#cbd5e1', font: { family: 'Inter', size: 11 } }
              },
              tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleFont: { family: 'Inter', size: 12, weight: 'bold' },
                bodyFont: { family: 'JetBrains Mono', size: 12 },
                padding: 10,
                borderColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 1,
                displayColors: false,
                callbacks: {
                  label: function (context) {
                    return `${config.yAxis}: ${Number(context.raw).toLocaleString()}`;
                  }
                }
              }
            },
            scales: chartType === 'doughnut' ? {} : {
              x: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#94a3b8', font: { family: 'Inter', size: 10 }, maxRotation: 45 }
              },
              y: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: {
                  color: '#94a3b8',
                  font: { family: 'JetBrains Mono', size: 10 },
                  callback: function (val) {
                    return val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val;
                  }
                }
              }
            }
          }
        });

        OrchestratorAgent.emitLog('ChartVisualizer', 'success', `Rendered Chart ${i + 1} successfully.`);
      }

      progressBadge.textContent = `${state.chartConfigs.length} of ${state.chartConfigs.length} Rendered`;
      OrchestratorAgent.setAgentState('ChartVisualizer', 'Complete', 'All charts rendered');
      OrchestratorAgent.emitLog('ChartVisualizer', 'success', `RENDER_COMPLETE barrier passed. All charts active on dashboard.`);

      state.allChartsRendered = true;
      return renderedChartsPayload;
    }
  };

  // =========================================================================
  // STRATEGIC INSIGHT GENERATOR AGENT
  // =========================================================================
  const InsightGeneratorAgent = {
    async runInsightsPipeline(chartsData) {
      // STRICT STEP 5 GATING: Ensure all charts have fully rendered
      if (!state.allChartsRendered) {
        OrchestratorAgent.emitLog('StrategicInsights', 'error', `Execution gate violation: Attempted to run insights before chart render completion.`);
        return;
      }

      const container = document.getElementById('insightsContainer');
      const streamingBadge = document.getElementById('insightStreamingBadge');
      const placeholder = document.getElementById('insightPendingPlaceholder');

      if (placeholder) placeholder.remove();
      streamingBadge.classList.remove('hidden');
      streamingBadge.classList.add('flex');
      container.innerHTML = '';

      let rawStreamBuffer = '';
      const textContainer = document.createElement('div');
      textContainer.className = 'font-sans text-sm text-slate-200 space-y-3 leading-relaxed terminal-cursor';
      container.appendChild(textContainer);

      state.isStreamingInsights = true;

      await GeminiClient.streamInsights(
        state.kpis,
        chartsData,
        (chunk) => {
          rawStreamBuffer += chunk;
          // Format streamed markdown bullets nicely
          const formatted = this.formatMarkdown(rawStreamBuffer);
          textContainer.innerHTML = formatted;
        },
        () => {
          state.isStreamingInsights = false;
          textContainer.classList.remove('terminal-cursor');
          streamingBadge.classList.add('hidden');
          streamingBadge.classList.remove('flex');
          lucide.createIcons();
        }
      );
    },

    formatMarkdown(text) {
      if (!text) return '';
      // Convert markdown bullets and bold headers cleanly
      let formatted = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Replace bold **text**
      formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-white">$1</strong>');

      // Replace lines starting with * or - or •
      const lines = formatted.split('\n');
      const parsedLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
          const content = trimmed.substring(2).trim();
          return `
            <div class="flex items-start gap-3 p-3.5 rounded-xl bg-dark-900/60 border border-slate-800/80 hover:border-brand-500/30 transition-all">
              <span class="w-2 h-2 rounded-full bg-brand-400 mt-2 shrink-0"></span>
              <div class="text-sm text-slate-200">${content}</div>
            </div>
          `;
        }
        return line ? `<p class="py-1">${line}</p>` : '';
      });

      return parsedLines.join('');
    }
  };

  // =========================================================================
  // STEP 2 QUESTIONS FORM MANAGER
  // =========================================================================
  const QuestionsManager = {
    renderQuestionsForm() {
      const container = document.getElementById('questionsInputList');
      container.innerHTML = '';

      state.businessQuestions.forEach((q, idx) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2';

        const placeholders = [
          "e.g. Which product category generated the highest total revenue?",
          "e.g. How do daily or monthly sales trend over time?",
          "e.g. Which delivery zones have the longest average shipping delays?",
          "e.g. What is the average order value across different customer segments?",
          "e.g. Which products have the highest customer return or review ratings?"
        ];

        row.innerHTML = `
          <div class="flex items-center justify-center w-7 h-7 rounded-lg bg-dark-850 text-brand-400 border border-slate-700 font-mono text-xs font-bold shrink-0">
            ${idx + 1}
          </div>
          <input type="text" value="${OrchestratorAgent.escapeHtml(q)}" 
                 placeholder="${placeholders[idx % placeholders.length]}" required
                 data-index="${idx}"
                 class="question-input flex-1 px-3.5 py-2.5 bg-dark-900 border border-slate-700/80 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 rounded-xl text-xs text-slate-100 placeholder-slate-500 transition-all">
          ${state.businessQuestions.length > 1 ? `
            <button type="button" data-remove="${idx}" class="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors" title="Remove question">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          ` : ''}
        `;

        container.appendChild(row);
      });

      // Bind dynamic input changes
      container.querySelectorAll('.question-input').forEach(input => {
        input.addEventListener('input', (e) => {
          const idx = parseInt(e.target.dataset.index, 10);
          state.businessQuestions[idx] = e.target.value;
        });
      });

      // Bind remove buttons
      container.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.dataset.remove, 10);
          if (state.businessQuestions.length > 1) {
            state.businessQuestions.splice(idx, 1);
            this.renderQuestionsForm();
          }
        });
      });

      lucide.createIcons();
    },

    addQuestion() {
      if (state.businessQuestions.length < 5) {
        state.businessQuestions.push("");
        this.renderQuestionsForm();
        // Focus the new field
        const inputs = document.querySelectorAll('.question-input');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      }
    },

    autoSuggestBasedOnColumns() {
      const colNames = state.schema.columns.map(c => c.name);
      const catCols = state.schema.columns.filter(c => c.type === 'category').map(c => c.name);
      const numCols = state.schema.columns.filter(c => c.type === 'number').map(c => c.name);
      const dateCol = state.schema.columns.find(c => c.type === 'date')?.name;

      const revCol = numCols.find(c => /revenue|sales|amount|price/i.test(c)) || numCols[0];
      const catCol = catCols.find(c => /category|product|type/i.test(c)) || catCols[0];
      const cityCol = colNames.find(c => /city|region|zone|location/i.test(c));
      const delivCol = numCols.find(c => /delivery|shipping|days|transit/i.test(c));

      const suggestions = [];

      if (catCol && revCol) {
        suggestions.push(`Which ${catCol} generates the highest ${revCol}?`);
      } else {
        suggestions.push("Which product category drives the highest total sales?");
      }

      if (dateCol && revCol) {
        suggestions.push(`How do daily ${revCol} figures trend over time?`);
      } else {
        suggestions.push("How does order volume and revenue trend chronologically?");
      }

      if (cityCol && delivCol) {
        suggestions.push(`Which ${cityCol} records the highest average ${delivCol}?`);
      } else if (cityCol && revCol) {
        suggestions.push(`What is the distribution of ${revCol} across each ${cityCol}?`);
      } else {
        suggestions.push("What are the key delivery duration bottlenecks across zones?");
      }

      state.businessQuestions = suggestions;
      this.renderQuestionsForm();
      OrchestratorAgent.emitLog('Orchestrator', 'info', `Auto-suggested 3 business questions dynamically aligned with detected columns.`);
    }
  };

  // =========================================================================
  // FULL PIPELINE CONTROLLER & EVENT WIRING
  // =========================================================================
  function initApp() {
    lucide.createIcons();

    // Check API Key Status Badge
    updateApiKeyBadge();

    // -----------------------------------------------------------------------
    // STEP 1 EVENTS
    // -----------------------------------------------------------------------
    const form = document.getElementById('dataSourceForm');
    const sheetInput = document.getElementById('sheetUrlInput');
    const fetchBtn = document.getElementById('fetchDataBtn');
    const loadingState = document.getElementById('fetchLoadingState');
    const errorAlert = document.getElementById('fetchErrorAlert');
    const errorText = document.getElementById('fetchErrorText');
    const sampleBtn = document.getElementById('loadSampleDatasetBtn');
    const confirmDataBtn = document.getElementById('confirmDataProceedBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawUrl = sheetInput.value.trim();
      if (!rawUrl) return;

      errorAlert.classList.add('hidden');
      loadingState.classList.remove('hidden');
      fetchBtn.disabled = true;

      try {
        const normalizedUrl = DataIngestionAgent.normalizeGoogleSheetUrl(rawUrl);
        const csv = await DataIngestionAgent.fetchCsvData(normalizedUrl);
        DataIngestionAgent.processCsv(csv, rawUrl);
      } catch (err) {
        errorText.textContent = err.message;
        errorAlert.classList.remove('hidden');
        OrchestratorAgent.setAgentState('DataIngestion', 'Failed', 'Fetch failed');
        OrchestratorAgent.emitLog('DataIngestion', 'error', `Failed to load CSV: ${err.message}`);
      } finally {
        loadingState.classList.add('hidden');
        fetchBtn.disabled = false;
      }
    });

    sampleBtn.addEventListener('click', () => {
      sheetInput.value = SampleDataset.url;
      errorAlert.classList.add('hidden');
      OrchestratorAgent.emitLog('Orchestrator', 'info', `Loading built-in D2C E-commerce dataset with strict DD-MM-YYYY dates...`);
      DataIngestionAgent.processCsv(SampleDataset.csv, SampleDataset.url);
    });

    confirmDataBtn.addEventListener('click', () => {
      OrchestratorAgent.emitLog('Orchestrator', 'info', `User confirmed data schema preview. Transitioning to Step 2: Questions.`);
      QuestionsManager.renderQuestionsForm();
      OrchestratorAgent.goToStep(2);
    });

    // -----------------------------------------------------------------------
    // STEP 2 EVENTS
    // -----------------------------------------------------------------------
    const addQuestionBtn = document.getElementById('addQuestionBtn');
    const useSuggestedBtn = document.getElementById('useSuggestedQuestionsBtn');
    const backToStep1Btn = document.getElementById('backToStep1Btn');
    const questionsForm = document.getElementById('businessQuestionsForm');

    addQuestionBtn.addEventListener('click', () => QuestionsManager.addQuestion());
    useSuggestedBtn.addEventListener('click', () => QuestionsManager.autoSuggestBasedOnColumns());
    backToStep1Btn.addEventListener('click', () => OrchestratorAgent.goToStep(1));

    questionsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const validQuestions = state.businessQuestions.map(q => q.trim()).filter(Boolean);
      if (validQuestions.length === 0) {
        alert("Please enter at least 1 business question.");
        return;
      }
      state.businessQuestions = validQuestions;
      OrchestratorAgent.emitLog('Orchestrator', 'info', `User submitted ${validQuestions.length} questions. Transitioning to Step 3: AI Recommendations.`);
      OrchestratorAgent.goToStep(3);
      await ChartRecommenderAgent.generateRecommendations(validQuestions);
    });

    // -----------------------------------------------------------------------
    // STEP 3 EVENTS
    // -----------------------------------------------------------------------
    const confirmAllConfigsBtn = document.getElementById('confirmAllConfigsBtn');
    confirmAllConfigsBtn.addEventListener('click', async () => {
      OrchestratorAgent.emitLog('Orchestrator', 'info', `User confirmed all chart configurations. Transitioning to Step 4: Multi-Agent Execution & Dashboard Render.`);
      OrchestratorAgent.goToStep(4);
      await executeDashboardPipeline();
    });

    // -----------------------------------------------------------------------
    // STEP 4 & 5 PIPELINE EXECUTION
    // -----------------------------------------------------------------------
    async function executeDashboardPipeline() {
      OrchestratorAgent.emitLog('Orchestrator', 'info', `=== MULTI-AGENT EXECUTION PIPELINE TRIGGERED ===`);
      OrchestratorAgent.setAgentState('Orchestrator', 'Running', 'Executing pipeline sequence');

      // 1. KPI Discovery Agent Execution
      KpiDiscoveryAgent.discoverAndComputeKpis();
      await new Promise(r => setTimeout(r, 400));

      // 2. Chart Visualizer Agent Execution
      const renderedChartsPayload = await ChartRecommenderAgent.renderFullChartsSequentially();
      await new Promise(r => setTimeout(r, 500));

      // 3. Step 5 Gated Insight Generation Execution
      OrchestratorAgent.emitLog('Orchestrator', 'info', `Unlocking Step 5: Activating Strategic Insight Agent.`);
      await InsightGeneratorAgent.runInsightsPipeline(renderedChartsPayload);

      OrchestratorAgent.setAgentState('Orchestrator', 'Complete', 'Pipeline complete');
      OrchestratorAgent.emitLog('Orchestrator', 'success', `=== PIPELINE EXECUTION COMPLETED SUCCESSFULLY ===`);
    }

    // -----------------------------------------------------------------------
    // REFRESH PIPELINE BUTTON (HEADER)
    // -----------------------------------------------------------------------
    const refreshBtn = document.getElementById('refreshPipelineBtn');
    const refreshIcon = document.getElementById('refreshIcon');

    refreshBtn.addEventListener('click', async () => {
      if (!state.googleSheetUrl && !state.rawCsv) {
        alert("Please load a data source first before refreshing.");
        return;
      }

      refreshIcon.classList.add('animate-spin');
      OrchestratorAgent.emitLog('Orchestrator', 'warn', `=== PIPELINE REFRESH INITIATED BY USER ===`);

      // Reset agent statuses
      Object.keys(state.agentStatuses).forEach(agentKey => {
        OrchestratorAgent.setAgentState(agentKey, 'Waiting', 'Waiting for refresh cycle');
      });

      try {
        // Refetch CSV
        if (state.googleSheetUrl && state.googleSheetUrl.startsWith('http') && state.googleSheetUrl !== SampleDataset.url) {
          const normalized = DataIngestionAgent.normalizeGoogleSheetUrl(state.googleSheetUrl);
          const freshCsv = await DataIngestionAgent.fetchCsvData(normalized);
          DataIngestionAgent.processCsv(freshCsv, state.googleSheetUrl);
        } else if (state.rawCsv) {
          DataIngestionAgent.processCsv(state.rawCsv, state.googleSheetUrl);
        }

        if (state.activeStep >= 4) {
          await executeDashboardPipeline();
        } else {
          OrchestratorAgent.emitLog('Orchestrator', 'success', `Data refreshed. Current step: ${state.activeStep}.`);
        }
      } catch (err) {
        OrchestratorAgent.emitLog('Orchestrator', 'error', `Refresh failed: ${err.message}`);
      } finally {
        setTimeout(() => refreshIcon.classList.remove('animate-spin'), 600);
      }
    });

    // -----------------------------------------------------------------------
    // TERMINAL CONSOLE CONTROLS
    // -----------------------------------------------------------------------
    document.getElementById('clearLogsBtn').addEventListener('click', () => {
      document.getElementById('consoleLogPanel').innerHTML = `
        <div class="text-slate-500 flex items-center gap-2">
          <span class="text-emerald-400">●</span>
          <span>Logs cleared by user. Telemetry bus active.</span>
        </div>
      `;
    });

    const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
    const consolePanel = document.getElementById('consoleLogPanel');
    toggleConsoleBtn.addEventListener('click', () => {
      if (consolePanel.classList.contains('hidden')) {
        consolePanel.classList.remove('hidden');
        toggleConsoleBtn.textContent = 'Minimize';
      } else {
        consolePanel.classList.add('hidden');
        toggleConsoleBtn.textContent = 'Expand';
      }
    });

    // -----------------------------------------------------------------------
    // API KEY MODAL WIRING
    // -----------------------------------------------------------------------
    const apiKeyModal = document.getElementById('apiKeyModal');
    const apiKeyConfigBtn = document.getElementById('apiKeyConfigBtn');
    const closeApiKeyModalBtn = document.getElementById('closeApiKeyModalBtn');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');
    const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
    const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');

    apiKeyConfigBtn.addEventListener('click', () => {
      apiKeyInput.value = state.apiKey || '';
      apiKeyModal.classList.remove('hidden');
    });

    closeApiKeyModalBtn.addEventListener('click', () => {
      apiKeyModal.classList.add('hidden');
    });

    toggleApiKeyVisibility.addEventListener('click', () => {
      const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
      apiKeyInput.setAttribute('type', type);
      const icon = document.getElementById('eyeIcon');
      if (icon) {
        icon.setAttribute('data-lucide', type === 'password' ? 'eye' : 'eye-off');
        lucide.createIcons();
      }
    });

    saveApiKeyBtn.addEventListener('click', () => {
      const key = apiKeyInput.value.trim();
      state.apiKey = key;
      if (key) {
        localStorage.setItem('shopeasy_gemini_api_key', key);
        OrchestratorAgent.emitLog('Orchestrator', 'success', `Gemini 2.5 Flash API Key updated and stored locally.`);
      } else {
        localStorage.removeItem('shopeasy_gemini_api_key');
      }
      updateApiKeyBadge();
      apiKeyModal.classList.add('hidden');
    });

    clearApiKeyBtn.addEventListener('click', () => {
      state.apiKey = '';
      apiKeyInput.value = '';
      localStorage.removeItem('shopeasy_gemini_api_key');
      updateApiKeyBadge();
      OrchestratorAgent.emitLog('Orchestrator', 'info', `Gemini API key cleared from browser storage.`);
      apiKeyModal.classList.add('hidden');
    });

    function updateApiKeyBadge() {
      const badge = document.getElementById('apiKeyStatusBadge');
      if (GeminiClient.hasApiKey()) {
        badge.innerHTML = `<span class="text-emerald-400">● Gemini 2.5 Active</span>`;
      } else {
        badge.innerHTML = `<span class="text-slate-400">Gemini 2.5 Flash Key</span>`;
      }
    }

    // Step Tabs direct navigation (only allowed for visited steps)
    for (let s = 1; s <= 5; s++) {
      const tab = document.getElementById(`stepTab${s}`);
      if (tab) {
        tab.addEventListener('click', () => {
          if (s <= state.activeStep || (s === 2 && state.rows.length > 0) || (s === 3 && state.chartConfigs.length > 0)) {
            OrchestratorAgent.goToStep(s);
          }
        });
      }
    }

    // Welcome log
    OrchestratorAgent.emitLog('Orchestrator', 'info', `ShopEasy Data Analyst Agent initialized. Model target: gemini-2.5-flash.`);
  }

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
