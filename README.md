# AlphaTrack🚀

**Institutional-Grade High-Frequency Trading & AI Analysis Suite**

AlphaTrack is a cloud-native quantitative terminal built on a decoupled serverless architecture. It migrates traditional financial analysis into a high-concurrency, AI-augmented environment.
- live demo: https://bwang0403.github.io/AlphaTrack-Engine/

## 🌟 Modern Enterprise Architecture (The 5 Pillars)

### 1. Distributed Order Matching (Event-Driven)
- **AWS SQS & DynamoDB**: Implemented an asynchronous order processing pipeline.
- **Optimistic Locking**: Utilizes DynamoDB `ConditionExpression` to prevent race conditions and "over-selling" in high-concurrency paper trading scenarios.

### 2. Quantum RAG Agent (LLM Analysis)
- **Context-Aware Insights**: Integrated **Groq (Llama 3.1)** with a custom RAG (Retrieval-Augmented Generation) engine.
- **Live Ingestion**: Dynamically fetches SEC 10-K summaries and real-time news via Wikipedia/Yahoo Finance APIs to eliminate AI hallucinations.

### 3. Parallel Simulation Engine (Multi-threading)
- **JavaScript Web Workers**: Offloads heavy **Monte Carlo (10,000 iterations)** pathfinding to background threads.
- **Main Thread UI Preservation**: Ensures a butter-smooth 60FPS UI experience while performing complex Geometric Brownian Motion (GBM) calculations.

### 4. Advanced Portfolio Risk Matrix
- **Quant Analytics**: Real-time calculation of **Sharpe Ratio**, **Beta (vs SPY)**, and **Max Drawdown**.
- **Vectorized Computation**: Leverages Python NumPy/Pandas for high-speed portfolio performance synthesis.

### 5. Full-Duplex Real-Time Data Stream
- **WebSocket (WSS) Architecture**: Mocked WSS interceptor with 500ms localized Canvas repainting.
- **HFT Visuals**: L2 Order Book and Dark Pool prints pulse with dynamic RGB status indicators based on trade direction.

---

## 🏗 System Stack
- **Backend**: AWS Lambda (Python 3.11), Boto3, SQS, DynamoDB.
- **AI**: Groq Cloud API, RAG Architecture.
- **Frontend**: Vanilla JS (ES6+), Web Workers, Chart.js, TailwindCSS, Canvas API.
- **Data**: yfinance, SEC EDGAR (Mock), Wikipedia API.

## 📂 Project Structure
- `app.html`: Core Terminal UI & WebSocket Logic.
- `lambda_function.py`: The "Brain" - handling RAG, Quant Math, and SQS ingestion.
- `index.html`: Intelligence Portal & Entryway.

---
*Developed by Bruce Wang | Computer Science @ University of Florida*
