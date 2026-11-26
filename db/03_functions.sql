-- 交易函式：會改到詞庫的動作都寫在這裡，網頁後端和匯入腳本呼叫同一批函式。
--
-- 兩條共同規則
--  1. 先鎖版本：凡是會寫變更清單的函式，第一步都呼叫 lock_draft()，鎖住草稿版本那一列。
--     大家都依「版本 → 審核紀錄／詞條」的順序上鎖，不會互相卡住（死結）。
--  2. 樂觀鎖：呼叫時帶上畫面上看到的 row_version；資料已被別人改過就失敗，請使用者重新整理。
--
-- 自訂錯誤代碼（後端依此回傳 HTTP 狀態）
--   LB001 沒有草稿版本　LB002 新詞名額已滿　LB003 資料已被其他人修改　LB004 輸入不合法
--
-- 每個函式最後一個參數 p_at 是「發生時間」，平常用 now()；匯入腳本照時間重演歷史時傳入當時的時間。


-- ==================== 共用 ====================

-- 鎖住目前的草稿版本並回傳。同一時間只有一個草稿（releases_one_draft 索引），所以不用迴圈找。
CREATE FUNCTION lock_draft() RETURNS releases
LANGUAGE plpgsql AS $$
DECLARE
  r releases;
BEGIN
  SELECT * INTO r FROM releases WHERE status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '目前沒有草稿版本，請先建立下一版' USING ERRCODE = 'LB001';
  END IF;
  RETURN r;
END $$;

-- 草稿版本已用掉幾個新詞名額
CREATE FUNCTION used_quota(p_release_id bigint) RETURNS integer
LANGUAGE sql STABLE
RETURN (SELECT count(*) FROM release_changes WHERE release_id = p_release_id AND action = 'add');

CREATE FUNCTION source_id_of(p_name text) RETURNS smallint
LANGUAGE sql STABLE
RETURN (SELECT source_id FROM sources WHERE name = p_name);


-- ==================== 1. 輸入法上傳新詞 ====================
-- 一次上傳一整批：{"text": "國旅券", "typed": "ㄍㄌㄑ", "count": 3}
-- 不合格的詞（含英數、太長、被封鎖）略過，不讓整批失敗；回傳收下與略過的筆數。
-- count 是輸入法自己累計的總次數，所以保留看過的最大值，並用 LEAST 封頂在 1,000,000。

-- 一批上傳裡合格的詞；同一批裡重複的合併成一筆
CREATE FUNCTION valid_upload(p_words jsonb)
RETURNS TABLE (text text, typed text, count integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT w.text, w.typed, LEAST(max(w.count), 1000000)
    FROM jsonb_to_recordset(p_words) AS w(text text, typed text, count integer)
   WHERE w.text ~ '^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\U00020000-\U000323AF]{1,20}$'
     AND w.typed ~ '^[ㄅ-ㄩˉˊˇˋ˙]{1,60}$'
     AND w.count >= 1
   GROUP BY w.text, w.typed
$$;

CREATE FUNCTION upload_words(
  p_device uuid, p_platform text, p_app text, p_words jsonb, p_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  total integer := jsonb_array_length(p_words);
  accepted integer;
BEGIN
  INSERT INTO devices (device_id, platform, app_version, first_seen, last_synced_at)
  VALUES (p_device, p_platform, p_app, p_at, p_at)
  ON CONFLICT (device_id) DO UPDATE
    SET app_version = EXCLUDED.app_version,
        last_synced_at = GREATEST(devices.last_synced_at, EXCLUDED.last_synced_at);

  -- 兩台裝置同時上傳同一個新詞：ON CONFLICT DO NOTHING，不會撞 UNIQUE
  INSERT INTO words (text) SELECT DISTINCT u.text FROM valid_upload(p_words) u ON CONFLICT DO NOTHING;

  -- 詞庫還沒有的詞才進待審
  INSERT INTO word_reviews (word_id)
  SELECT w.word_id FROM words w JOIN (SELECT DISTINCT u.text FROM valid_upload(p_words) u) u USING (text)
   WHERE NOT EXISTS (SELECT 1 FROM lexicon_entries e WHERE e.word_id = w.word_id AND e.status <> 'retired')
  ON CONFLICT DO NOTHING;

  -- 被封鎖的詞由 trigger 略過
  INSERT INTO submissions (device_id, word_id, typed, use_count, first_seen, last_seen)
  SELECT p_device, w.word_id, u.typed, u.count, p_at, p_at
    FROM valid_upload(p_words) u JOIN words w USING (text)
  ON CONFLICT (device_id, word_id, typed) DO UPDATE
    SET use_count = GREATEST(submissions.use_count, EXCLUDED.use_count),
        last_seen = GREATEST(submissions.last_seen, EXCLUDED.last_seen);
  GET DIAGNOSTICS accepted = ROW_COUNT;

  RETURN jsonb_build_object('accepted', accepted, 'skipped', total - accepted);
END $$;


-- ==================== 2. 審核：加入新詞 ====================
-- 一個交易做完四件事，失敗就全部回復（R10）：
--   鎖草稿版本 → 檢查名額 → 審核紀錄改成加入 → 建立 staged 詞條並寫入變更清單
-- p_readings：[{"bopomofo": "ㄍㄨㄛˊ ㄌㄩˇ ㄑㄩㄢˋ", "frequency": 500}]，一個讀音占一個名額
CREATE FUNCTION approve_word(
  p_word_id bigint, p_editor bigint, p_row_version integer, p_readings jsonb,
  p_at timestamptz DEFAULT now()
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r releases := lock_draft();                       -- 第 1 步：先鎖版本
  n integer := jsonb_array_length(p_readings);
  reading record;
  new_entry bigint;
BEGIN
  IF n = 0 THEN
    RAISE EXCEPTION '至少要有一個讀音' USING ERRCODE = 'LB004';
  END IF;

  -- 第 2 步：鎖住之後才數名額，數到的一定是最新的
  IF used_quota(r.release_id) + n > r.max_new_words THEN
    RAISE EXCEPTION '版本 % 的新詞名額不夠（已用 %/%，這次要 %）',
      r.version, used_quota(r.release_id), r.max_new_words, n USING ERRCODE = 'LB002';
  END IF;

  -- 第 3 步：樂觀鎖。別人先審過，row_version 已經變了，更新 0 筆
  UPDATE word_reviews
     SET status = 'approved', reviewer_id = p_editor, decided_at = p_at
   WHERE word_id = p_word_id AND status = 'pending' AND row_version = p_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION '這個詞剛剛已被其他編輯處理，請重新整理' USING ERRCODE = 'LB003';
  END IF;

  -- 第 4 步：建立詞條、寫入變更清單
  FOR reading IN SELECT * FROM jsonb_to_recordset(p_readings) AS x(bopomofo text, frequency integer) LOOP
    INSERT INTO lexicon_entries (word_id, bopomofo, frequency, source_id, status, updated_by, updated_at)
    VALUES (p_word_id, reading.bopomofo, reading.frequency, source_id_of('使用者投稿'), 'staged', p_editor, p_at)
    RETURNING entry_id INTO new_entry;

    INSERT INTO release_changes (release_id, entry_id, action, new_frequency)
    VALUES (r.release_id, new_entry, 'add', reading.frequency);
  END LOOP;

  RETURN r.version;
END $$;


-- ==================== 3. 審核：不收、封鎖、重新審核 ====================
-- 不碰詞庫和變更清單，所以不用鎖版本，只用樂觀鎖
CREATE FUNCTION decide_word(
  p_word_id bigint, p_editor bigint, p_row_version integer, p_status text,
  p_at timestamptz DEFAULT now()
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_status NOT IN ('rejected', 'blocked', 'pending') THEN
    RAISE EXCEPTION '加入請用 approve_word、撤回請用 withdraw_word' USING ERRCODE = 'LB004';
  END IF;

  UPDATE word_reviews
     SET status      = p_status,
         reviewer_id = CASE WHEN p_status = 'pending' THEN NULL ELSE p_editor END,
         decided_at  = CASE WHEN p_status = 'pending' THEN NULL ELSE p_at END
   WHERE word_id = p_word_id AND row_version = p_row_version
     AND status <> 'approved';                     -- 加入過的詞只能用撤回
  IF NOT FOUND THEN
    RAISE EXCEPTION '這個詞剛剛已被其他編輯處理，請重新整理' USING ERRCODE = 'LB003';
  END IF;
  -- 不合規定的狀態變化（如 封鎖 → 不收）由 trigger 擋下
END $$;


-- ==================== 4. 審核：撤回加入 ====================
-- 編輯按錯「加入」：在草稿版本發布前，刪掉 staged 詞條和變更，審核紀錄回到待審
CREATE FUNCTION withdraw_word(
  p_word_id bigint, p_editor bigint, p_row_version integer
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r releases := lock_draft();
BEGIN
  UPDATE word_reviews
     SET status = 'pending', reviewer_id = NULL, decided_at = NULL
   WHERE word_id = p_word_id AND status = 'approved' AND row_version = p_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION '這個詞剛剛已被其他編輯處理，請重新整理' USING ERRCODE = 'LB003';
  END IF;
  -- 詞條已發布的話，上面的 UPDATE 會被 trigger 擋下，整個交易回復

  DELETE FROM release_changes c USING lexicon_entries e
   WHERE c.release_id = r.release_id AND c.entry_id = e.entry_id
     AND e.word_id = p_word_id AND e.status = 'staged';
  DELETE FROM lexicon_entries WHERE word_id = p_word_id AND status = 'staged';
END $$;


-- ==================== 5. 維護詞庫：停用、調詞頻 ====================
-- 記在草稿版本的變更清單，發布時才真的套用。
-- 同一版對同一詞條只有一筆變更（R14）：再改一次就合併，例如 500→800 又改成 600，只留 500→600；
-- 改回原值就刪掉這筆變更。
-- 樂觀鎖：比對詞條的 row_version，並在詞條上記下修改者（trigger 把 row_version 加 1）。
CREATE FUNCTION change_entry(
  p_entry_id bigint, p_editor bigint, p_row_version integer,
  p_action text, p_new_frequency integer DEFAULT NULL, p_at timestamptz DEFAULT now()
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r releases := lock_draft();
  e lexicon_entries;
BEGIN
  IF p_action NOT IN ('remove', 'reweight') OR (p_action = 'reweight') <> (p_new_frequency IS NOT NULL) THEN
    RAISE EXCEPTION '停用不帶詞頻；調詞頻要帶新詞頻' USING ERRCODE = 'LB004';
  END IF;
  -- trigger 只在修改者換人時檢查，上次也是自己改的話要在這裡擋
  PERFORM assert_editor(p_editor, '修改詞條的人');

  UPDATE lexicon_entries SET updated_by = p_editor, updated_at = p_at
   WHERE entry_id = p_entry_id AND status = 'active' AND row_version = p_row_version
  RETURNING * INTO e;
  IF NOT FOUND THEN
    RAISE EXCEPTION '這個詞條剛剛已被其他編輯修改，請重新整理' USING ERRCODE = 'LB003';
  END IF;

  DELETE FROM release_changes WHERE release_id = r.release_id AND entry_id = p_entry_id;
  IF p_action = 'remove' THEN
    INSERT INTO release_changes (release_id, entry_id, action, old_frequency)
    VALUES (r.release_id, p_entry_id, 'remove', e.frequency);
  ELSIF p_new_frequency <> e.frequency THEN
    INSERT INTO release_changes (release_id, entry_id, action, old_frequency, new_frequency)
    VALUES (r.release_id, p_entry_id, 'reweight', e.frequency, p_new_frequency);
  END IF;
END $$;


-- ==================== 6. 處理回報 ====================
-- p_resolution：
--   dismiss      駁回，不改詞庫
--   remove       停用這個詞條（不是詞、冒犯）
--   reweight     調詞頻
--   fix_reading  讀音錯：停用舊詞條＋新增正確讀音的詞條（新的占一個名額）
CREATE FUNCTION resolve_report(
  p_report_id bigint, p_editor bigint, p_resolution text,
  p_entry_row_version integer DEFAULT NULL,
  p_new_frequency integer DEFAULT NULL, p_new_bopomofo text DEFAULT NULL,
  p_at timestamptz DEFAULT now()
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rp reports;
  r releases;
  old_entry lexicon_entries;
  new_entry bigint;
BEGIN
  IF p_resolution = 'dismiss' THEN
    UPDATE reports SET status = 'dismissed', handler_id = p_editor, handled_at = p_at
     WHERE report_id = p_report_id AND status = 'open';
    IF NOT FOUND THEN
      RAISE EXCEPTION '這筆回報剛剛已被其他編輯處理' USING ERRCODE = 'LB003';
    END IF;
    RETURN;
  END IF;

  r := lock_draft();
  SELECT * INTO rp FROM reports WHERE report_id = p_report_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '這筆回報剛剛已被其他編輯處理' USING ERRCODE = 'LB003';
  END IF;

  IF p_resolution IN ('remove', 'reweight') THEN
    PERFORM change_entry(rp.entry_id, p_editor, p_entry_row_version, p_resolution, p_new_frequency, p_at);

  ELSIF p_resolution = 'fix_reading' THEN
    IF used_quota(r.release_id) >= r.max_new_words THEN
      RAISE EXCEPTION '版本 % 的新詞名額已滿，無法新增正確讀音', r.version USING ERRCODE = 'LB002';
    END IF;
    SELECT * INTO old_entry FROM lexicon_entries WHERE entry_id = rp.entry_id;
    PERFORM change_entry(rp.entry_id, p_editor, p_entry_row_version, 'remove', NULL, p_at);

    INSERT INTO lexicon_entries (word_id, bopomofo, frequency, source_id, status, updated_by, updated_at)
    VALUES (old_entry.word_id, p_new_bopomofo, old_entry.frequency, source_id_of('編輯'), 'staged', p_editor, p_at)
    RETURNING entry_id INTO new_entry;
    INSERT INTO release_changes (release_id, entry_id, action, new_frequency)
    VALUES (r.release_id, new_entry, 'add', old_entry.frequency);

  ELSE
    RAISE EXCEPTION '不認得的處理方式 %', p_resolution USING ERRCODE = 'LB004';
  END IF;

  UPDATE reports SET status = 'resolved', handler_id = p_editor, handled_at = p_at
   WHERE report_id = p_report_id;
END $$;


-- ==================== 7. 發布版本 ====================
-- 依變更清單套用到詞條，再把版本改成已發布。
-- 跟加入新詞搶同一把鎖：發布期間有人按加入，會等發布完，再收到「沒有草稿版本」。
CREATE FUNCTION publish_release(p_editor bigint, p_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  r releases := lock_draft();
  added integer; removed integer; reweighted integer;
BEGIN
  PERFORM assert_editor(p_editor, '發布版本的人');

  UPDATE lexicon_entries e SET status = 'active', updated_at = p_at
    FROM release_changes c
   WHERE c.release_id = r.release_id AND c.entry_id = e.entry_id AND c.action = 'add';
  GET DIAGNOSTICS added = ROW_COUNT;

  UPDATE lexicon_entries e SET status = 'retired', updated_at = p_at
    FROM release_changes c
   WHERE c.release_id = r.release_id AND c.entry_id = e.entry_id AND c.action = 'remove';
  GET DIAGNOSTICS removed = ROW_COUNT;

  UPDATE lexicon_entries e SET frequency = c.new_frequency, updated_at = p_at
    FROM release_changes c
   WHERE c.release_id = r.release_id AND c.entry_id = e.entry_id AND c.action = 'reweight';
  GET DIAGNOSTICS reweighted = ROW_COUNT;

  UPDATE releases SET status = 'published', published_at = p_at WHERE release_id = r.release_id;

  RETURN jsonb_build_object('version', r.version, 'added', added, 'removed', removed, 'reweighted', reweighted);
END $$;


-- ==================== 8. 維護詞庫：編輯直接新增詞條 ====================
-- 不經過投稿與審核，編輯自己加一個詞（例如輕注音 1.0 加入的「什麼意思」）。
-- 跟加入新詞一樣先鎖版本、占一個名額；來源記為「編輯」。
CREATE FUNCTION add_entry(
  p_text text, p_bopomofo text, p_frequency integer, p_editor bigint,
  p_at timestamptz DEFAULT now()
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  r releases := lock_draft();
  w bigint;
  new_entry bigint;
BEGIN
  IF used_quota(r.release_id) >= r.max_new_words THEN
    RAISE EXCEPTION '版本 % 的新詞名額已滿', r.version USING ERRCODE = 'LB002';
  END IF;

  INSERT INTO words (text) VALUES (p_text) ON CONFLICT DO NOTHING;
  SELECT word_id INTO w FROM words WHERE text = p_text;

  INSERT INTO lexicon_entries (word_id, bopomofo, frequency, source_id, status, updated_by, updated_at)
  VALUES (w, p_bopomofo, p_frequency, source_id_of('編輯'), 'staged', p_editor, p_at)
  RETURNING entry_id INTO new_entry;
  INSERT INTO release_changes (release_id, entry_id, action, new_frequency)
  VALUES (r.release_id, new_entry, 'add', p_frequency);
  RETURN new_entry;
END $$;
