# AlphaTrack Verified v5.2 🚀
### **Institutional-Grade Quantitative Intelligence Terminal**

**AlphaTrack Verified** is a high-performance, cloud-native stock analysis engine. It leverages a serverless AWS architecture to synthesize real-time technical signals, options flow, and SEC insider filings into a single actionable matrix. 

The interface features a bespoke **"Aether Glass"** UI, combining high-end glassmorphism with dynamic, interactive charting and verified macroeconomic data streams.

## 🔗 Live Demo
[**Click here to launch the AlphaTrack Terminal**](https://bwang0403.github.io/AlphaTrack-Engine/)

> **Note:** Since this is a serverless application utilizing live data scraping (Options Chains, SEC filings), the first request might take a few seconds (up to 10s) to wake up the AWS Lambda function and fetch the quantum data.

---

## 🏗 System Architecture
This project is built on a **Decoupled Serverless Architecture**, ensuring zero infrastructure overhead and high scalability:

* **Compute:** AWS Lambda (Python 3.x) performing high-speed vector calculations and data synthesis via `Pandas` and `NumPy`.
* **Data Ingestion:** `yfinance` API and native XML parsing for real-time market data, Options Chains, and SEC Form 4 Atom feeds.
* **API Layer:** AWS Lambda Function URL acting as a RESTful bridge between the client and the quant engine with full CORS configuration.
* **Frontend:** Zero-build-step Vanilla JavaScript paired with TailwindCSS delivered via CDN for maximum rendering speed.
* **State Management:** Browser `localStorage` engine for persistent, privacy-focused Paper Trading portfolio tracking.

---

## 🌟 Key Technical Highlights

### 1. **100% Verified Data Streams**
AlphaTrack v5.2 eliminates mocked data, pulling raw truth directly from the market:
* **Options Wall (OI):** Parses near-the-money Calls and Puts to establish algorithmic support/resistance and calculate live P/C Ratios.
* **Insider Radar:** Directly parses SEC databases for executive and board member accumulation/liquidation activities.
* **Macro Sentinels:** Global regime tracking via real-time VIX, US 10-Year Bond Yields, Gold, and Crude Oil.

### 2. **Neural Decision Engine**
The engine utilizes adaptive logic to evaluate market conditions:
* **Dynamic Tagging:** Automatically categorizes equities (e.g., `🔥 MEGA CAP`, `🚀 GROWTH`, `💰 VALUE`) based on real-time trailing P/E and market capitalization.
* **Algorithmic Synthesis:** Generates human-readable "Neural Conclusions" (Buy/Sell/Risk) by cross-referencing RSI momentum with fundamental valuation premiums.

### 3. **Aether Glass UI/UX**
A high-fidelity frontend designed for professional clarity:
* **Kinetic Background:** Full-screen drifting "Aether" blobs that visualize market energy.
* **Interactive Data Viz:** `Chart.js` integrated with custom crosshair plugins for precision price-action tracking on a 120-day synthesis window.
* **Glassmorphism:** Frosted-glass components with `backdrop-blur-25px` and highly responsive grid matrices.

---

## 📊 Quant Metrics Included
* **Annualized Volatility ($\sigma$):** Calculated based on 252-day trading returns.
* **RSI (Relative Strength Index):** Real-time overbought/oversold detection using adaptive smoothing windows.
* **Implied Volatility (IV):** Extracted directly from options chains to gauge market-maker risk pricing.
* **52-Week Gravity Radar:** Visualizes current spot price relative to annual extremes to define algorithmic range floors.

---

## 📂 Repository Structure
* `index.html`: The Intelligence Search portal and Macro Sentiment dashboard.
* `app.html`: The core Quantum Terminal, Interactive Charting, and Portfolio Tracking UI.
* `lambda_function.py`: The Python source code for the AWS Lambda engine.

---

## 🚀 Future Roadmap
- [ ] Integration with AWS DynamoDB for persistent cross-device portfolio syncing.
- [ ] Dark pool print and block trade API integrations.
- [ ] Multi-ticker correlation heatmaps and backtesting modules.

---

**Developed by Bruce Wang** *Computer Science Student @ University of Florida*
