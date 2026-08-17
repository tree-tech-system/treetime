-- Backfills every existing company with the same default dashboard_widgets
-- that new companies get from src/lib/defaultWidgets.js -- these used to be
-- hardcoded cards in the frontend; now they're ordinary rows an admin can
-- remove, reorder, or edit like any widget they create themselves.
DO $$
DECLARE
  comp RECORD;
  next_pos INTEGER;
BEGIN
  FOR comp IN SELECT id FROM companies LOOP
    SELECT COALESCE(MAX(position), -1) + 1 INTO next_pos FROM dashboard_widgets WHERE company_id = comp.id;

    INSERT INTO dashboard_widgets (company_id, type, title, config, position) VALUES
      (comp.id, 'kpi', 'עובדים פעילים החודש', '{"data_source":"employees_activity","filters":{}}'::jsonb, next_pos),
      (comp.id, 'kpi', 'לקוחות מעל 80% מכסה', '{"data_source":"clients_usage","filters":{"threshold_pct":80}}'::jsonb, next_pos + 1),
      (comp.id, 'kpi', 'שעונים פתוחים כרגע', '{"data_source":"time_entries","aggregation":"count","filters":{"status":"open"}}'::jsonb, next_pos + 2),
      (comp.id, 'kpi', 'סה״כ שעות החודש', '{"data_source":"time_entries","aggregation":"sum","field":"duration_hours","filters":{"date_from":"this_month_start","date_to":"today"}}'::jsonb, next_pos + 3),
      (comp.id, 'list', 'מכסת שעות ללקוח', '{"source":"clients_usage","filters":{}}'::jsonb, next_pos + 4),
      (comp.id, 'list', 'פעילות עובדים', '{"source":"employees_activity","filters":{}}'::jsonb, next_pos + 5),
      (comp.id, 'list', 'דיווחים אחרונים', '{"source":"time_entries","filters":{}}'::jsonb, next_pos + 6);
  END LOOP;
END $$;
