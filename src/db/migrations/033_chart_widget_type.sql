-- Third dashboard widget type: a bar chart that groups a data source by a
-- categorical field (e.g. tasks by status, time entries by employee) and
-- aggregates a value per group. Reuses the same allowlist-based query engine
-- as the KPI widget (src/lib/kpiEngine.js) -- this only widens what "type"
-- a dashboard_widgets row is allowed to be.
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_type_check CHECK (type IN ('kpi', 'list', 'chart'));
