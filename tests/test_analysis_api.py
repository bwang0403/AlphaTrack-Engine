"""Regression tests for the stock-analysis API."""

from datetime import datetime
import math
import socket
import statistics
import unittest

import pandas as pd

from backend_harness import BackendCase, market_frame, strict_json


class AnalysisContractTests(BackendCase):
    def test_default_ticker_and_period(self):
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual((payload["ticker"], payload["period"]), ("NVDA", "6mo"))
        self.download.assert_called_once_with("NVDA", period="6mo", interval="1d", progress=False)

    def test_explicit_ticker_is_uppercased(self):
        response, payload = self.call(self.request(ticker=" aapl "))
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["ticker"], "AAPL")
        self.assertEqual(self.download.call_args.args, ("AAPL",))

    def test_top_level_event_fields_are_supported(self):
        _, payload = self.call({"ticker": "msft", "period": "1mo"})
        self.assertEqual((payload["ticker"], payload["period"]), ("MSFT", "1mo"))

    def test_query_fields_take_precedence(self):
        _, payload = self.call({"ticker": "MSFT", "period": "1y",
                                "queryStringParameters": {"ticker": "qqq", "period": "5d"}})
        self.assertEqual((payload["ticker"], payload["period"]), ("QQQ", "5d"))

    def test_empty_query_fields_fall_back(self):
        _, payload = self.call(self.request(ticker="", period=""))
        self.assertEqual((payload["ticker"], payload["period"]), ("NVDA", "6mo"))
        _, payload = self.call({"queryStringParameters": None})
        self.assertEqual(payload["ticker"], "NVDA")

    def test_supported_periods_are_forwarded(self):
        # Fixture length is deliberately independent of provider period filtering.
        for period in ("5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y"):
            with self.subTest(period=period):
                response, payload = self.call(self.request(period=period))
                self.assertEqual(response["statusCode"], 200)
                self.assertEqual(payload["period"], period)
                self.assertEqual(self.download.call_args.kwargs["period"], period)

    def test_unknown_period_is_rejected_before_provider_call(self):
        response, payload = self.call(self.request(period="not-a-period"))
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(payload, {"error": "period is not supported"})
        self.download.assert_not_called()

    def test_invalid_ticker_formats_are_rejected_before_provider_call(self):
        for ticker in ("AAPL,MSFT", "AAPL&action=add_trade", "../NVDA", "AAPL USD"):
            with self.subTest(ticker=ticker):
                response, payload = self.call(self.request(ticker=ticker))
                self.assertEqual(response["statusCode"], 400)
                self.assertEqual(payload, {"error": "ticker format is invalid"})
                self.download.assert_not_called()

    def test_success_response_shape_and_headers(self):
        response, payload = self.call()
        self.assertEqual(set(response), {"statusCode", "headers", "body"})
        self.assertEqual(response["headers"], {"Content-Type": "application/json",
                                               "Access-Control-Allow-Origin": "*"})
        self.assertEqual(strict_json(response["body"]), payload)
        self.assertEqual(set(payload), {"ticker", "period", "current", "history_signals", "history", "data"})
        self.assertEqual(set(payload["current"]), {"price", "rsi", "advice", "vol", "tp", "sl"})
        self.assertEqual(set(payload["data"]), {"supports", "resistances"})

    def test_current_values_for_known_fixture(self):
        _, payload = self.call()
        current = payload["current"]
        # Independent expected volatility from the fixture's alternating returns.
        returns = [0.02 if index % 2 == 0 else -2 / 102 for index in range(39)]
        self.assertEqual(current, {"price": 102.0, "rsi": 50.0, "advice": "SELL",
                                   "vol": round(statistics.stdev(returns) * math.sqrt(252) * 100, 2),
                                   "tp": 101.97, "sl": 97.02})

    def test_history_preserves_all_provider_dates_and_closes(self):
        _, payload = self.call()
        self.assertEqual(payload["history"], [
            {"x": date.strftime("%Y-%m-%d"), "y": float(price)}
            for date, price in self.frame["Close"].items()
        ])

    def test_supports_and_resistances_have_expected_extrema(self):
        _, payload = self.call()
        self.assertEqual(payload["data"]["supports"], [
            {"date": self.frame.index[i].strftime("%Y-%m-%d"), "price": 99.0}
            for i in range(6, 35, 2)
        ])
        self.assertEqual(payload["data"]["resistances"], [
            {"date": self.frame.index[i].strftime("%Y-%m-%d"), "price": 103.0}
            for i in range(5, 35, 2)
        ])

    def test_signal_write_and_history_query(self):
        _, payload = self.call()
        self.boto3.resource.assert_called_once_with("dynamodb")
        self.resource.Table.assert_called_once_with("AlphaTrackSignals")
        item = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(set(item), {"ticker", "timestamp", "price", "advice"})
        self.assertEqual((item["ticker"], item["price"], item["advice"]), ("NVDA", "102.0", "SELL"))
        datetime.fromisoformat(item["timestamp"])
        self.table.query.assert_called_once_with(
            KeyConditionExpression=("eq", "ticker", "NVDA"), ScanIndexForward=False, Limit=5)
        self.assertEqual(payload["history_signals"], self.signal_records)

    def test_missing_query_items_returns_empty_history(self):
        self.table.query.return_value = {}
        _, payload = self.call()
        self.assertEqual(payload["history_signals"], [])

    def test_provider_failure_returns_500(self):
        self.download.side_effect = RuntimeError("synthetic provider failure")
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(payload, {"error": "synthetic provider failure"})
        self.assertEqual(response["headers"], {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        })
        self.table.put_item.assert_not_called()

    def test_empty_market_data_returns_500(self):
        self.frame = market_frame(0)
        response, payload = self.call(self.request(ticker="EMPTY"))
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(payload, {"error": "Ticker EMPTY not found."})
        self.table.put_item.assert_not_called()

    def test_dynamodb_write_failure_is_hidden(self):
        self.table.put_item.side_effect = RuntimeError("synthetic write failure")
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["history_signals"], [])
        self.assertEqual(payload["current"]["price"], 102.0)
        self.table.query.assert_not_called()

    def test_dynamodb_query_failure_is_hidden_after_write(self):
        self.table.query.side_effect = RuntimeError("synthetic query failure")
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["history_signals"], [])
        self.table.put_item.assert_called_once()

    def test_short_history_uses_null_rsi_with_strict_json(self):
        self.frame = market_frame(5)
        response, payload = self.call(self.request(period="5d"))
        self.assertEqual(response["statusCode"], 200)
        self.assertIsNone(payload["current"]["rsi"])
        # The 5d period uses a one-observation extrema window, even though RSI
        # still needs fourteen observations.
        self.assertEqual(payload["data"], {
            "supports": [{"date": "2026-01-03", "price": 99.0}],
            "resistances": [{"date": "2026-01-02", "price": 103.0},
                            {"date": "2026-01-04", "price": 103.0}],
        })
        self.assertEqual(len(payload["history"]), 5)
        self.assertEqual(strict_json(response["body"]), payload)

    def test_single_row_history_uses_null_indicators_with_strict_json(self):
        self.frame = market_frame(1)
        response, payload = self.call(self.request(period="5d"))
        self.assertEqual(response["statusCode"], 200)
        self.assertIsNone(payload["current"]["rsi"])
        self.assertIsNone(payload["current"]["vol"])
        self.assertEqual(payload["current"]["advice"], "NEUTRAL")
        self.assertEqual(strict_json(response["body"]), payload)

    def test_flat_prices_use_null_rsi_with_strict_json(self):
        self.frame.loc[:, "Close"] = 100.0
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["current"]["vol"], 0.0)
        self.assertIsNone(payload["current"]["rsi"])
        self.assertEqual(strict_json(response["body"]), payload)

    def test_no_extrema_uses_price_based_targets(self):
        # A 20-observation window cannot find extrema in this 40-row fixture.
        response, payload = self.call(self.request(period="5y"))
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["data"], {"supports": [], "resistances": []})
        self.assertEqual(payload["current"]["tp"], 106.03)
        self.assertEqual(payload["current"]["sl"], 94.96)

    def test_non_finite_close_returns_strict_error_json(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                self.frame = market_frame()
                self.frame.iloc[-1, self.frame.columns.get_loc("Close")] = value
                response, payload = self.call()
                self.assertEqual(response["statusCode"], 500)
                self.assertEqual(payload, {
                    "error": "Market data field Close contains non-finite values"
                })
                self.assertEqual(strict_json(response["body"]), payload)
                self.table.put_item.assert_not_called()

    def test_malformed_events_return_explicit_validation_errors(self):
        for event in (None, [], {"queryStringParameters": ["ticker"]},
                      self.request(ticker=123), self.request(period={"bad": True})):
            with self.subTest(event=event):
                response = self.backend.lambda_handler(event, None)
                self.assertEqual(response["statusCode"], 400)
                self.assertEqual(set(strict_json(response["body"])), {"error"})

    def test_missing_close_column_returns_500(self):
        self.frame = self.frame.drop(columns="Close")
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 500)
        self.assertIn("Close", payload["error"])

    def test_single_ticker_multiindex_provider_frame_is_normalized(self):
        self.frame.columns = pd.MultiIndex.from_product([self.frame.columns, ["NVDA"]])
        response, payload = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(payload["current"]["price"], 102.0)
        self.assertEqual(len(payload["history"]), 40)
        self.table.put_item.assert_called_once()

    def test_socket_guard_prevents_network_access(self):
        with self.assertRaisesRegex(AssertionError, "Network access is forbidden"):
            socket.create_connection(("example.invalid", 443))


class ActionBoundaryTests(BackendCase):
    def assert_rejected_without_analysis(self, params, status_code):
        response, payload = self.call(self.request(**params))
        self.assertEqual(response["statusCode"], status_code)
        self.assertEqual(set(payload), {"error"})
        self.assertNotIn("current", payload)
        self.download.assert_not_called()
        self.table.put_item.assert_not_called()

    def test_get_portfolio_is_explicitly_unsupported(self):
        self.assert_rejected_without_analysis({"action": "get_portfolio", "period": "1mo",
                                               "user_id": "fixture-user"}, 400)

    def test_add_trade_get_is_rejected(self):
        self.assert_rejected_without_analysis({"action": "add_trade", "ticker": "aapl",
                                               "price": "1", "quantity": "10",
                                               "user_id": "fixture-user",
                                               "idempotency_key": "fixture-order"}, 405)

    def test_sell_trade_get_is_rejected(self):
        self.assert_rejected_without_analysis({"action": "sell_trade", "ticker": "msft",
                                               "price": "1", "quantity": "10",
                                               "user_id": "fixture-user",
                                               "idempotency_key": "fixture-order"}, 405)

    def test_unknown_action_is_rejected(self):
        self.assert_rejected_without_analysis({"action": "not_supported"}, 400)

    def test_trade_get_is_rejected_before_quantity_processing(self):
        for quantity in ("abc", "-5", "0", "NaN", "Infinity", ""):
            with self.subTest(quantity=quantity):
                response, payload = self.call(self.request(action="add_trade", quantity=quantity))
                self.assertEqual(response["statusCode"], 405)
                self.assertEqual(set(payload), {"error"})
                self.download.assert_not_called()

    def test_valid_paper_order_is_explicitly_not_implemented(self):
        event = {
            "rawPath": "/paper/orders",
            "requestContext": {"http": {"method": "POST"}},
            "body": '{"side":"BUY","ticker":"NVDA","quantity":1}',
        }
        response, payload = self.call(event)
        self.assertEqual(response["statusCode"], 501)
        self.assertEqual(payload, {"error": "paper trading is not implemented"})
        self.download.assert_not_called()
        self.table.put_item.assert_not_called()


if __name__ == "__main__":
    unittest.main()
