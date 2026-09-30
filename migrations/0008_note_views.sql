-- KPI: note閲覧数(PV)自動収集用の列
ALTER TABLE kpi_daily ADD COLUMN note_views_total INTEGER DEFAULT 0;
