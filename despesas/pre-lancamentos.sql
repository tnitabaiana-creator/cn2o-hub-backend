-- A missing date or an unidentified recipient is not proof of a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS despesas_duplicate_identified_expense ON despesas_entries
 ((lower(trim(data->>'supplier'))), (data->>'paidDate'), ((data->>'cents')::bigint))
 WHERE COALESCE(data->>'paidDate','') <> ''
 AND lower(trim(data->>'supplier')) NOT LIKE 'favorecido a identificar%';
DROP INDEX IF EXISTS despesas_duplicate_expense;
