CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (scope, limit_key, bucket_start)
);

CREATE INDEX rate_limits_bucket_idx ON rate_limits(bucket_start);
