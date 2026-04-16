import yfinance as yf
import pandas as pd
import json

def get_stock_data(ticker, period='60d', interval='1d'):
    """抓取股票数据"""
    data = yf.download(ticker, period=period, interval=interval, progress=False)
    return data

def find_support_resistance(df, window=5):
    """计算支撑/压力位"""
    supports, resistances = [], []
    lows = df['Low'].iloc[:, 0].values
    highs = df['High'].iloc[:, 0].values
    dates = df.index

    for i in range(window, len(df) - window):
        if lows[i] == min(lows[i-window : i+window+1]):
            supports.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(lows[i], 2)})
        if highs[i] == max(highs[i-window : i+window+1]):
            resistances.append({"date": dates[i].strftime('%Y-%m-%d'), "price": round(highs[i], 2)})

    return supports, resistances

# ==========================================
# 核心改造：云端函数的标准入口 (AWS Lambda 格式)
# ==========================================
def lambda_handler(event, context):
    """
    AWS Lambda 触发时，只会执行这个函数。
    event: 前端或定时器传进来的参数 (比如传进来了股票代码)
    """
    # 1. 接收外部传入的参数，如果没有传，默认算 NVDA，窗口为 5
    target_ticker = event.get('ticker', 'NVDA')
    window_size = event.get('window', 5)
    
    print(f"--> 云端函数被触发: 计算 {target_ticker}, Window={window_size}")

    # 2. 调用核心逻辑
    df = get_stock_data(target_ticker)
    supports, resistances = find_support_resistance(df, window=window_size)
    
    # 3. 组装成标准的 HTTP/API JSON 响应格式
    response = {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps({
            "ticker": target_ticker,
            "parameters": {"window_size": window_size, "period": "60d"},
            "data": {
                "supports": supports,
                "resistances": resistances
            }
        }, indent=4)  # indent=4 是为了在终端打印时好看点
    }
    
    return response

# --- 本地测试区 ---
if __name__ == "__main__":
    # 模拟前端发给云端服务器的请求参数
    mock_event = {
        "ticker": "QQQ",
        "window": 6
    }
    
    # 运行并打印云端格式的结果
    api_response = lambda_handler(mock_event, None)
    print("\n=== 云端 API 返回结果 (JSON) ===")
    print(api_response['body'])