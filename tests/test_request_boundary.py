"""Regression tests for request validation and the safe API boundary."""

import json
import unittest

from backend_harness import BackendCase, market_frame, strict_json


class RequestBoundaryTests(BackendCase):
    def test_unsupported_action_is_not_analysis(self):
        response, payload = self.call(self.request(action="not_supported"))
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("error", payload)
        self.assertNotIn("current", payload)
        self.download.assert_not_called()

    def test_trade_get_is_method_not_allowed(self):
        for action in ("add_trade", "sell_trade"):
            with self.subTest(action=action):
                response, _ = self.call(self.request(action=action, ticker="NVDA", quantity="1"))
                self.assertEqual(response["statusCode"], 405)
                self.table.put_item.assert_not_called()

    def test_invalid_action_returns_error(self):
        response, payload = self.call(self.request(action=["add_trade"]))
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("error", payload)
        self.download.assert_not_called()

    def test_malformed_quantity_is_rejected(self):
        for quantity in ("abc", "-1", "0", "NaN", "Infinity"):
            with self.subTest(quantity=quantity):
                event = {"rawPath": "/paper/orders", "requestContext": {
                    "http": {"method": "POST"},
                    "authorizer": {"jwt": {"claims": {"sub": "fixture-user"}}}},
                    "body": json.dumps({"side": "BUY", "ticker": "NVDA",
                                        "quantity": quantity}),
                    "headers": {"Idempotency-Key": "fixture-key"}}
                response, payload = self.call(event)
                self.assertEqual(response["statusCode"], 400)
                self.assertIn("error", payload)
                self.table.put_item.assert_not_called()

    def test_analysis_cannot_masquerade_as_trade_success(self):
        response, payload = self.call(self.request(action="add_trade", ticker="NVDA", quantity="1"))
        self.assertGreaterEqual(response["statusCode"], 400)
        self.assertNotIn("current", payload)

    def test_every_response_is_strict_json(self):
        frames = [market_frame(5)]
        for value in (float("nan"), float("inf"), float("-inf")):
            frame = market_frame()
            frame.iloc[-1, frame.columns.get_loc("Close")] = value
            frames.append(frame)
        for frame in frames:
            with self.subTest(last_close=frame["Close"].iloc[-1]):
                self.frame = frame
                response, _ = self.call()
                strict_json(response["body"])
