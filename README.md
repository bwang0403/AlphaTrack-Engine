# AlphaTrack Liquid v2.7 🚀
### **Institutional-Grade Quantitative Intelligence Terminal**

**AlphaTrack Liquid** is a high-performance, cloud-native stock analysis engine. It leverages a serverless AWS architecture to provide real-time technical signals (Buy/Sell/Hold) based on adaptive market structures and volatility modeling. 

The interface features a bespoke **"Aether Liquid"** UI, combining high-end glassmorphism with synthesized haptic audio feedback.

---

## 🏗 System Architecture
This project is built on a **Decoupled Serverless Architecture**, ensuring zero infrastructure overhead and high scalability:

* **Compute:** AWS Lambda (Python 3.12) performing high-speed vector calculations via `Pandas` and `NumPy`.
* **Data Ingestion:** `yfinance` API for real-time market data retrieval across multiple timeframes (5D to 5Y).
* **Database:** Amazon DynamoDB (NoSQL) for persistent signal logging and historical attribution.
* **API Layer:** AWS API Gateway acting as a RESTful bridge between the client and the quant engine.
* **Automation:** AWS EventBridge (CloudWatch Events) for scheduled, asynchronous market analysis at closing bells.

---

## 🌟 Key Technical Highlights

### 1. **Adaptive Structural Filtering**
The engine utilizes an **Adaptive Smoothing Window** logic. It dynamically adjusts the sensitivity of the support and resistance detection based on the user-selected period.
* **Short-Term:** Captures micro-reversals and retail momentum.
* **Long-Term:** Identifies "Institutional Floors" and macro-resistance levels that span years.

### 2. **Aether Liquid UI/UX**
A high-fidelity frontend designed for professional clarity:
* **Kinetic Background:** Full-screen drifting "Aether" blobs (Crimson and Electric Blue) that visualize market energy.
* **Glassmorphism:** Frosted-glass components with `backdrop-blur-40px` and soft-pill interactive elements.
* **Haptic Physics:** UI interactions utilize `cubic-bezier` transitions for a "soft" tactile feel.

### 3. **Signature Audio Engine**
Utilizing the **Web Audio API**, AlphaTrack synthesizes professional-grade audio feedback in real-time (No external assets required):
* **Buy Signal:** A bright, ascending C-Major arpeggio (C5-E5-G5).
* **Sell Signal:** A warm, descending cadence (G4-E4-C4).
* **Haptic Click:** A 160Hz to 40Hz exponential frequency ramp mimicking iPhone haptic feedback.

---

## 📊 Quant Metrics Included
* **Annualized Volatility ($\sigma$):** Calculated based on 252-day trading returns.
* **RSI (Relative Strength Index):** Real-time overbought/oversold detection.
* **Dynamic Price Targets:** Algorithmic Profit-Taking and Stop-Loss levels based on nearest structural pivots.

---

## 📂 Repository Structure
* `frontend/`: Contains the `index.html` with Aether Liquid UI and Sonic Engine.
* `backend/`: Python source code for the AWS Lambda function.
* `infrastructure/`: Documentation for AWS setup (DynamoDB schema, IAM roles).

---

## 🚀 Future Roadmap
- [ ] Integration with AWS SNS for SMS/Email trade alerts.
- [ ] Multi-ticker comparison dashboards.
- [ ] Portfolio backtesting engine using historical DynamoDB logs.

---

**Developed by Bruce Wang** *Computer Science Student @ University of Florida*
