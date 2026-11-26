-- 冒煙測試：把「國旅券」主線和每條規則跑一遍。全部包在交易裡，最後 ROLLBACK，不留資料。
-- 每一行印出 ✓ 或 ✗；有任何 ✗ 最後會報錯。

\set QUIET on
\set VERBOSITY terse
\o /dev/null
BEGIN;

CREATE TEMP TABLE failures (label text);

-- expect(說明, SQL)：應該成功
-- expect(說明, SQL, 錯誤代碼)：應該失敗，而且錯誤代碼要對
CREATE FUNCTION pg_temp.expect(label text, stmt text, code text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN assert_failure OR others THEN
    IF code = SQLSTATE THEN
      RAISE NOTICE '✓ %（擋下：%）', label, SQLERRM;
    ELSE
      RAISE NOTICE '✗ %：%（%）', label, SQLERRM, SQLSTATE;
      INSERT INTO failures VALUES (label);
    END IF;
    RETURN;
  END;
  IF code IS NULL THEN
    RAISE NOTICE '✓ %', label;
  ELSE
    RAISE NOTICE '✗ %：應該被擋下卻成功了', label;
    INSERT INTO failures VALUES (label);
  END IF;
END $$;

-- 測試資料
INSERT INTO users (user_id, email, password_hash, display_name, role) VALUES
  (901, 'a@test', 'x', '編輯A', 'editor'),
  (902, 'b@test', 'x', '編輯B', 'editor'),
  (903, 'u@test', 'x', '路人', 'user');
INSERT INTO sources (name) VALUES ('新酷音'), ('使用者投稿'), ('編輯') ON CONFLICT DO NOTHING;
INSERT INTO words (word_id, text) VALUES (901, '你好'), (902, '覺得');
INSERT INTO lexicon_entries (entry_id, word_id, bopomofo, frequency, source_id, status) VALUES
  (901, 901, 'ㄋㄧˇ ㄏㄠˇ', 100, source_id_of('新酷音'), 'active'),
  (902, 902, 'ㄐㄩㄝˊ ㄉㄜ', 80, source_id_of('新酷音'), 'active');

DO $$ BEGIN RAISE NOTICE '— 上傳'; END $$;
SELECT pg_temp.expect('沒有草稿版本時不能加入',
  $$SELECT approve_word(1, 901, 1, '[]')$$, 'LB001');
SELECT pg_temp.expect('一批上傳（含英數、重複）',
  $$SELECT upload_words('11111111-1111-1111-1111-111111111111', 'macos', '8.0',
    '[{"text":"國旅券","typed":"ㄍㄌㄑ","count":3},{"text":"國旅券","typed":"ㄍㄌㄑ","count":5},
      {"text":"iPhone","typed":"ㄅ","count":1},{"text":"普發","typed":"ㄆㄈ","count":2000000}]')$$);
SELECT pg_temp.expect('使用次數封頂 1,000,000',
  $t$DO $$ BEGIN ASSERT (SELECT max(use_count) FROM submissions) = 1000000; END $$$t$);

DO $$ BEGIN RAISE NOTICE '— 投票'; END $$;
SELECT pg_temp.expect('投票給待審的國旅券',
  $$INSERT INTO votes VALUES (903, (SELECT word_id FROM words WHERE text = '國旅券'), 1)$$);
SELECT pg_temp.expect('投票給已收錄的你好',
  $$INSERT INTO votes VALUES (903, 901, 1)$$, '23514');

DO $$ BEGIN RAISE NOTICE '— 審核'; END $$;
INSERT INTO releases (release_id, version, max_new_words, created_by) VALUES (901, '9.0', 1, 901);
SELECT pg_temp.expect('第二個草稿版本',
  $$INSERT INTO releases (version, created_by) VALUES ('10.0', 901)$$, '23505');
SELECT pg_temp.expect('編輯 A 加入國旅券',
  $$SELECT approve_word((SELECT word_id FROM words WHERE text = '國旅券'), 901, 1,
    '[{"bopomofo":"ㄍㄨㄛˊ ㄌㄩˇ ㄑㄩㄢˋ","frequency":500}]')$$);
SELECT pg_temp.expect('加入後不能再投票',
  $$INSERT INTO votes VALUES (902, (SELECT word_id FROM words WHERE text = '國旅券'), 1)$$, '23514');
SELECT pg_temp.expect('編輯 B 用舊畫面再審國旅券（樂觀鎖）',
  $$SELECT decide_word((SELECT word_id FROM words WHERE text = '國旅券'), 902, 1, 'rejected')$$, 'LB003');
SELECT pg_temp.expect('名額已滿時加入普發',
  $$SELECT approve_word((SELECT word_id FROM words WHERE text = '普發'), 902, 1,
    '[{"bopomofo":"ㄆㄨˇ ㄈㄚ","frequency":300}]')$$, 'LB002');
SELECT pg_temp.expect('一般使用者不能做審核決定',
  $$SELECT decide_word((SELECT word_id FROM words WHERE text = '普發'), 903, 1, 'blocked')$$, '23514');
SELECT pg_temp.expect('編輯 A 撤回國旅券',
  $$SELECT withdraw_word((SELECT word_id FROM words WHERE text = '國旅券'), 901, 2)$$);
SELECT pg_temp.expect('撤回後名額回到 0',
  $t$DO $$ BEGIN ASSERT used_quota(901) = 0; END $$$t$);
SELECT pg_temp.expect('編輯 B 加入普發',
  $$SELECT approve_word((SELECT word_id FROM words WHERE text = '普發'), 902, 1,
    '[{"bopomofo":"ㄆㄨˇ ㄈㄚ","frequency":300}]')$$);
UPDATE releases SET max_new_words = 5 WHERE release_id = 901;

DO $$ BEGIN RAISE NOTICE '— 維護詞庫'; END $$;
SELECT pg_temp.expect('不能直接改讀音',
  $$UPDATE lexicon_entries SET bopomofo = 'ㄋㄧˊ ㄏㄠˇ' WHERE entry_id = 901$$, '23514');
SELECT pg_temp.expect('調「你好」詞頻 100 → 150',
  $$SELECT change_entry(901, 901, 1, 'reweight', 150)$$);
SELECT pg_temp.expect('拿舊版本號再調一次（樂觀鎖）',
  $$SELECT change_entry(901, 902, 1, 'reweight', 120)$$, 'LB003');
SELECT pg_temp.expect('不能回報還沒發布的普發',
  $$INSERT INTO reports (user_id, entry_id, kind)
    SELECT 903, entry_id, 'not_word' FROM lexicon_entries e JOIN words USING (word_id) WHERE text = '普發'$$, '23514');

DO $$ BEGIN RAISE NOTICE '— 發布'; END $$;
SELECT pg_temp.expect('發布 9.0', $$SELECT publish_release(901)$$);
SELECT pg_temp.expect('發布後普發上線、你好詞頻是 150',
  $t$DO $$ BEGIN
      ASSERT (SELECT status FROM lexicon_entries e JOIN words USING (word_id) WHERE text = '普發') = 'active';
      ASSERT (SELECT frequency FROM lexicon_entries WHERE entry_id = 901) = 150;
    END $$$t$);
SELECT pg_temp.expect('不能改已發布版本的變更清單',
  $$DELETE FROM release_changes WHERE release_id = 901$$, '23514');
SELECT pg_temp.expect('不能刪除已發布的詞條',
  $$DELETE FROM lexicon_entries WHERE entry_id = 901$$, '23514');
SELECT pg_temp.expect('版本號要遞增：9.0 之後不能建 8.5',
  $$INSERT INTO releases (version, created_by) VALUES ('8.5', 901)$$, '23514');
SELECT pg_temp.expect('10.0 排在 9.0 之後（不是字串比較）',
  $$INSERT INTO releases (release_id, version, created_by) VALUES (902, '10.0', 901)$$);

DO $$ BEGIN RAISE NOTICE '— 回報'; END $$;
INSERT INTO reports (report_id, user_id, entry_id, kind) VALUES (901, 903, 902, 'wrong_reading');
SELECT pg_temp.expect('同一人同一詞條同類回報不能重複',
  $$INSERT INTO reports (user_id, entry_id, kind) VALUES (903, 902, 'wrong_reading')$$, '23505');
SELECT pg_temp.expect('「覺得」讀音錯：停用舊的＋新增正確讀音',
  $$SELECT resolve_report(901, 902, 'fix_reading', 1, NULL, 'ㄐㄩㄝˊ ㄉㄜ˙')$$);
SELECT pg_temp.expect('處理完的回報不能再改',
  $$SELECT resolve_report(901, 901, 'dismiss')$$, 'LB003');
SELECT pg_temp.expect('發布 10.0 後「覺得」換成正確讀音',
  $t$DO $$ BEGIN
      PERFORM publish_release(901);
      ASSERT (SELECT string_agg(bopomofo || ':' || status, ',' ORDER BY status)
                FROM lexicon_entries WHERE word_id = 902) = 'ㄐㄩㄝˊ ㄉㄜ˙:active,ㄐㄩㄝˊ ㄉㄜ:retired';
    END $$$t$);

DO $$ BEGIN RAISE NOTICE '— 個人詞與詞庫包'; END $$;
SELECT pg_temp.expect('個人詞不能真的刪除',
  $$INSERT INTO personal_words VALUES (903, 901, 'ㄋㄧˇ ㄏㄠˇ'); DELETE FROM personal_words WHERE user_id = 903$$, '23514');
SELECT pg_temp.expect('不能訂閱草稿詞庫包',
  $$INSERT INTO packs (pack_id, name, owner_id) VALUES (901, '台灣地名', 901);
    INSERT INTO subscriptions VALUES (903, 901)$$, '23514');

DO $$ BEGIN RAISE NOTICE '— 停權的編輯'; END $$;
INSERT INTO releases (release_id, version, created_by) VALUES (903, '11.0', 901);
SELECT pg_temp.expect('編輯 B 在草稿裡新增詞條、調詞頻，並建立詞庫包',
  $$SELECT add_entry('夜市', 'ㄧㄝˋ ㄕˋ', 100, 902);
    SELECT change_entry(901, 902, (SELECT row_version FROM lexicon_entries WHERE entry_id = 901), 'reweight', 200);
    INSERT INTO packs (pack_id, name, owner_id) VALUES (902, '夜市小吃', 902)$$);
UPDATE users SET status = 'suspended' WHERE user_id = 902;
SELECT pg_temp.expect('停權的編輯不能再改自己改過的詞條',
  $$SELECT change_entry(901, 902, (SELECT row_version FROM lexicon_entries WHERE entry_id = 901), 'reweight', 250)$$, '23514');
SELECT pg_temp.expect('停權的編輯不能建立詞庫包',
  $$INSERT INTO packs (name, owner_id) VALUES ('飲料', 902)$$, '23514');
SELECT pg_temp.expect('詞庫包不能改給一般使用者',
  $$UPDATE packs SET owner_id = 903 WHERE pack_id = 902$$, '23514');
SELECT pg_temp.expect('建立者停權後，詞庫包仍可上架、下架',
  $$UPDATE packs SET status = 'published' WHERE pack_id = 902;
    UPDATE packs SET status = 'archived' WHERE pack_id = 902$$);
SELECT pg_temp.expect('改過詞條的編輯停權後，草稿版本仍可發布',
  $t$DO $$ BEGIN
      PERFORM publish_release(901);
      ASSERT (SELECT status FROM lexicon_entries e JOIN words USING (word_id) WHERE text = '夜市') = 'active';
      ASSERT (SELECT frequency FROM lexicon_entries WHERE entry_id = 901) = 200;
    END $$$t$);

DO $$ BEGIN RAISE NOTICE '— 漢字範圍（R4）'; END $$;
SELECT pg_temp.expect('韓文不是漢字',
  $$INSERT INTO words (text) VALUES (U&'\D55C\AE00')$$, '23514');
SELECT pg_temp.expect('私用區字元不是漢字',
  $$INSERT INTO words (text) VALUES (U&'\E000')$$, '23514');
SELECT pg_temp.expect('相容區與擴充 B 的漢字可以收',
  $$INSERT INTO words (text) VALUES (U&'\F900'), (U&'\+020000')$$);
SELECT pg_temp.expect('上傳時略過韓文',
  $t$DO $$ BEGIN
      ASSERT (upload_words('22222222-2222-2222-2222-222222222222', 'macos', '8.0',
        jsonb_build_array(jsonb_build_object('text', U&'\D55C\AE00', 'typed', 'ㄅ', 'count', 1)))->>'accepted')::int = 0;
    END $$$t$);

DO $$
DECLARE n integer := (SELECT count(*) FROM failures);
BEGIN
  IF n > 0 THEN RAISE EXCEPTION '有 % 項測試失敗', n; END IF;
  RAISE NOTICE '全部通過';
END $$;

ROLLBACK;
