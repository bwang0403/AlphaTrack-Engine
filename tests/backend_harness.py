"""Load the CURRENT handler with real math libraries and no external services."""

import importlib.util
import json
from contextlib import ExitStack
from pathlib import Path
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]


def market_frame(rows=40):
    """Synthetic daily closes alternate 100/102; these are not market quotes."""
    closes = [100.0 if index % 2 == 0 else 102.0 for index in range(rows)]
    return pd.DataFrame(
        {"Close": closes, "Low": [p - 1 for p in closes],
         "High": [p + 1 for p in closes]},
        index=pd.date_range("2026-01-01", periods=rows, freq="D"),
    )


def strict_json(body):
    def reject_constant(value):
        raise ValueError(f"Non-standard JSON constant: {value}")

    return json.loads(body, parse_constant=reject_constant)


class BackendCase(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        # Guard both import-time and handler-time networking, including DNS.
        for target in (
            "socket.socket.connect", "socket.socket.connect_ex",
            "socket.create_connection", "socket.getaddrinfo",
        ):
            stack.enter_context(patch(target, side_effect=AssertionError(
                "Network access is forbidden in contract tests"
            )))

        self.frame = market_frame()
        self.signal_records = [{"ticker": "NVDA", "timestamp": "2026-01-01T12:00:00",
                                "price": "100.0", "advice": "NEUTRAL"}]
        self.table = Mock(name="signal_table", spec=["put_item", "query"])
        self.table.query.return_value = {"Items": self.signal_records}
        self.resource = Mock(name="dynamodb_resource", spec=["Table"])
        self.resource.Table.return_value = self.table

        boto3 = ModuleType("boto3")
        boto3.resource = Mock(return_value=self.resource)
        dynamodb = ModuleType("boto3.dynamodb")
        conditions = ModuleType("boto3.dynamodb.conditions")

        class Key:
            def __init__(self, name):
                self.name = name

            def eq(self, value):
                return ("eq", self.name, value)

        conditions.Key = Key
        dynamodb.conditions = conditions
        boto3.dynamodb = dynamodb
        yfinance = ModuleType("yfinance")
        self.download = Mock(side_effect=lambda *args, **kwargs: self.frame.copy(deep=True))
        yfinance.download = self.download
        stack.enter_context(patch.dict("sys.modules", {
            "boto3": boto3, "boto3.dynamodb": dynamodb,
            "boto3.dynamodb.conditions": conditions, "yfinance": yfinance,
        }))
        spec = importlib.util.spec_from_file_location(
            "alphatrack_contract_subject", ROOT / "lambda_function.py"
        )
        self.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.backend)
        self.boto3 = boto3

    def call(self, event=None):
        response = self.backend.lambda_handler({} if event is None else event, None)
        return response, json.loads(response["body"])

    @staticmethod
    def request(**params):
        return {"queryStringParameters": params,
                "requestContext": {"http": {"method": "GET"}}}
