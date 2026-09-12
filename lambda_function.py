import yfinance as yf
import pandas as pd
import json
import boto3
import numpy as np
import math
import re
from datetime import datetime
from boto3.dynamodb.conditions import Key

# Initialize AWS Services
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('AlphaTrackSignals')

RESPONSE_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
}
WINDOW_BY_PERIOD = {
    '5d': 1,
    '1mo': 2,
    '3mo': 3,
    '6mo': 5,
    'ytd': 5,
    '1y': 8,
    '2y': 12,
    '5y': 20,
}
TICKER_PATTERN = re.compile(r"^[A-Z0-9^][A-Z0-9.^_=-]{0,14}$")
TRADE_ACTIONS = {'add_trade', 'sell_trade'}


class RequestError(Exception):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code


def json_response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": RESPONSE_HEADERS.copy(),
        "body": json.dumps(payload, allow_nan=False),
    }


def get_http_method(event):
    request_context = event.get('requestContext') or {}
    http_context = request_context.get('http') or {}
    method = http_context.get('method') or event.get('httpMethod') or 'GET'
    return method.upper() if isinstance(method, str) else ''


def validate_ticker(value):
    if not isinstance(value, str):
        raise RequestError(400, "ticker must be a string")
    ticker = value.strip().upper()
    if not ticker or not TICKER_PATTERN.fullmatch(ticker):
        raise RequestError(400, "ticker format is invalid")
    return ticker


def validate_paper_order_request(event):
    if get_http_method(event) != 'POST':
        raise RequestError(405, "paper orders require POST")

    raw_body = event.get('body')
    try:
        body = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
    except json.JSONDecodeError as exc:
        raise RequestError(400, "request body must be valid JSON") from exc
    if not isinstance(body, dict):
        raise RequestError(400, "request body must be a JSON object")

    side = body.get('side')
    if not isinstance(side, str) or side.upper() not in {'BUY', 'SELL'}:
        raise RequestError(400, "side must be BUY or SELL")
    validate_ticker(body.get('ticker'))

    try:
        quantity = float(body.get('quantity'))
    except (TypeError, ValueError) as exc:
        raise RequestError(400, "quantity must be a positive finite number") from exc
    if not math.isfinite(quantity) or quantity <= 0:
        raise RequestError(400, "quantity must be a positive finite number")

    # The request boundary is reserved, but paper execution is a later phase.
    raise RequestError(501, "paper trading is not implemented")


def validate_request(event):
    if not isinstance(event, dict):
        raise RequestError(400, "event must be an object")

    params = event.get('queryStringParameters')
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise RequestError(400, "queryStringParameters must be an object")

    raw_path = event.get('rawPath') or event.get('path')
    if raw_path == '/paper/orders':
        validate_paper_order_request(event)

    if 'action' in params:
        action = params.get('action')
        if not isinstance(action, str) or not action.strip():
            raise RequestError(400, "action must be a non-empty string")
        action = action.strip()
        if action in TRADE_ACTIONS:
            if get_http_method(event) != 'POST':
                raise RequestError(405, "trade actions require POST")
            raise RequestError(501, "paper trading is not implemented")
        raise RequestError(400, f"unsupported action: {action}")

    raw_ticker = params.get('ticker') or event.get('ticker') or 'NVDA'
    ticker = validate_ticker(raw_ticker)

    raw_period = params.get('period') or event.get('period') or '6mo'
    if not isinstance(raw_period, str):
        raise RequestError(400, "period must be a string")
    period = raw_period.strip().lower()
    if period not in WINDOW_BY_PERIOD:
        raise RequestError(400, "period is not supported")
    return ticker, period


def get_market_series(frame, field):
    if field not in frame:
        raise ValueError(f"Market data is missing {field}")
    series = frame[field]
    if isinstance(series, pd.DataFrame):
        if series.shape[1] != 1:
            raise ValueError(f"Market data contains multiple {field} series")
        series = series.iloc[:, 0]
    if not isinstance(series, pd.Series):
        raise ValueError(f"Market data field {field} is invalid")

    series = pd.to_numeric(series, errors='coerce')
    values = series.to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError(f"Market data field {field} contains non-finite values")
    return series.astype(float)


def rounded_finite(value):
    value = float(value)
    return round(value, 2) if math.isfinite(value) else None

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
        ticker, period = validate_request(event)
        df = yf.download(ticker, period=period, interval='1d', progress=False)
        if df.empty: raise ValueError(f"Ticker {ticker} not found.")

        close = get_market_series(df, 'Close')
        low = get_market_series(df, 'Low')
        high = get_market_series(df, 'High')
        if close.empty:
            raise ValueError(f"Ticker {ticker} not found.")

        window = WINDOW_BY_PERIOD[period]
        returns = close.pct_change()
        volatility = rounded_finite(returns.std() * np.sqrt(252) * 100)
        sma_20 = close.rolling(window=20).mean()
        rsi = calculate_rsi(close)
        curr_price = round(float(close.iloc[-1]), 2)
        curr_rsi = rounded_finite(rsi.iloc[-1])
        curr_sma = rounded_finite(sma_20.iloc[-1])
        if curr_sma is None:
            curr_sma = curr_price

        supports, resistances = [], []
        lows = low.to_numpy()
        highs = high.to_numpy()
        dates = df.index
        for i in range(window, len(df) - window):
            if lows[i] == min(lows[i-window : i+window+1]):
                supports.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(float(lows[i]), 2)})
            if highs[i] == max(highs[i-window : i+window+1]):
                resistances.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(float(highs[i]), 2)})

        advice = get_signal(curr_price, curr_rsi if curr_rsi is not None else 50.0,
                            curr_sma, supports, resistances)
        latest_sup = supports[-1]['price'] if supports else curr_price * 0.95
        latest_res = resistances[-1]['price'] if resistances else curr_price * 1.05
        tp, sl = round(latest_res * 0.99, 2), round(latest_sup * 0.98, 2)

        timestamp = datetime.now().isoformat()
        try:
            table.put_item(Item={'ticker': ticker, 'timestamp': timestamp, 'price': str(curr_price), 'advice': advice})
            history_data = table.query(KeyConditionExpression=Key('ticker').eq(ticker), ScanIndexForward=False, Limit=5).get('Items', [])
        except Exception:
            history_data = []

        history_line = [{"x": d.strftime('%Y-%m-%d'), "y": round(float(p), 2)} 
                        for d, p in close.items()]

        return json_response(200, {
            "ticker": ticker, "period": period,
            "current": {"price": curr_price, "rsi": curr_rsi, "advice": advice,
                        "vol": volatility, "tp": tp, "sl": sl},
            "history_signals": history_data, "history": history_line,
            "data": {"supports": supports, "resistances": resistances}
        })
    except RequestError as e:
        return json_response(e.status_code, {"error": str(e)})
    except Exception as e:
        return json_response(500, {"error": str(e)})
