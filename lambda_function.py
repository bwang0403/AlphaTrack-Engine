import yfinance as yf
import pandas as pd
import json
import traceback
import boto3
import numpy as np
from datetime import datetime
from boto3.dynamodb.conditions import Key

# Initialize AWS Services
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('AlphaTrackSignals')

def calculate_rsi(prices, period=14):
    delta = prices.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))

def get_signal(price, rsi, sma, supports, resistances):
    score = 0
    latest_sup = supports[-1]['price'] if supports else price * 0.95
    latest_res = resistances[-1]['price'] if resistances else price * 1.05
    if rsi < 32: score += 2 
    if rsi > 68: score -= 2
    if price <= latest_sup * 1.015: score += 2 
    if price >= latest_res * 0.985: score -= 2
    if price > sma: score += 1
    if score >= 3: return "STRONG BUY"
    if score >= 1: return "BUY"
    if score <= -3: return "STRONG SELL"
    if score <= -1: return "SELL"
    return "NEUTRAL"

def lambda_handler(event, context):
    try:
        params = event.get('queryStringParameters') or {}
        ticker = (params.get('ticker') or event.get('ticker') or 'NVDA').upper()
        period = params.get('period') or event.get('period') or '6mo'
        df = yf.download(ticker, period=period, interval='1d', progress=False)
        if df.empty: raise ValueError(f"Ticker {ticker} not found.")

        # Adaptive Filtering Logic
        window_map = {'5d':1, '1mo':2, '3mo':3, '6mo':5, 'ytd':5, '1y':8, '2y':12, '5y':20}
        window = window_map.get(period, 5)

        df['Returns'] = df['Close'].pct_change()
        volatility = round(float(df['Returns'].std() * np.sqrt(252) * 100), 2)
        df['SMA_20'] = df['Close'].rolling(window=20).mean()
        df['RSI'] = calculate_rsi(df['Close'])
        curr_price = round(float(df['Close'].iloc[-1]), 2)
        curr_rsi = round(float(df['RSI'].iloc[-1]), 2)
        curr_sma = round(float(df['SMA_20'].fillna(curr_price).iloc[-1]), 2)

        supports, resistances = [], []
        lows = df['Low'].iloc[:, 0].values if isinstance(df['Low'], pd.DataFrame) else df['Low'].values
        highs = df['High'].iloc[:, 0].values if isinstance(df['High'], pd.DataFrame) else df['High'].values
        dates = df.index
        for i in range(window, len(df) - window):
            if lows[i] == min(lows[i-window : i+window+1]):
                supports.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(float(lows[i]), 2)})
            if highs[i] == max(highs[i-window : i+window+1]):
                resistances.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(float(highs[i]), 2)})

        advice = get_signal(curr_price, curr_rsi, curr_sma, supports, resistances)
        latest_sup = supports[-1]['price'] if supports else curr_price * 0.95
        latest_res = resistances[-1]['price'] if resistances else curr_price * 1.05
        tp, sl = round(latest_res * 0.99, 2), round(latest_sup * 0.98, 2)

        timestamp = datetime.now().isoformat()
        try:
            table.put_item(Item={'ticker': ticker, 'timestamp': timestamp, 'price': str(curr_price), 'advice': advice})
            history_data = table.query(KeyConditionExpression=Key('ticker').eq(ticker), ScanIndexForward=False, Limit=5).get('Items', [])
        except: history_data = []

        history_line = [{"x": d.strftime('%Y-%m-%d'), "y": round(float(p), 2)} 
                        for d, p in (df['Close'].iloc[:, 0] if isinstance(df['Close'], pd.DataFrame) else df['Close']).items()]

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({
                "ticker": ticker, "period": period,
                "current": {"price": curr_price, "rsi": curr_rsi, "advice": advice, "vol": volatility, "tp": tp, "sl": sl},
                "history_signals": history_data, "history": history_line,
                "data": {"supports": supports, "resistances": resistances}
            })
        }
    except Exception as e:
        return {"statusCode": 500, "headers": {"Access-Control-Allow-Origin": "*"}, "body": json.dumps({"error": str(e)})}