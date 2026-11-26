-- 規則檢查（trigger）：CHECK 與外鍵表達不了、需要查其他表的規則。
-- 規則編號 R1–R21 對照計劃書附錄 A。
-- 每個 trigger 都在資料庫裡擋，所以不論是網頁、輸入法或匯入腳本寫入，規則都一樣。


-- ==================== 共用 ====================

-- 這個帳號必須是在職編輯（NULL 不檢查，由各表自己決定能不能 NULL）
CREATE FUNCTION assert_editor(uid bigint, what text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF uid IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM users WHERE user_id = uid AND role = 'editor' AND status = 'active') THEN
    RAISE EXCEPTION '%必須是編輯（user_id = %）', what, uid USING ERRCODE = 'check_violation';
  END IF;
END $$;


-- ==================== 新詞投稿與投票 ====================

-- R6：被封鎖的詞不再接受投稿。
-- 輸入法一次上傳一整批，這裡不丟錯誤，而是回傳 NULL「略過這一筆」，其他詞照常寫入。
CREATE FUNCTION submissions_skip_blocked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM word_reviews WHERE word_id = NEW.word_id AND status = 'blocked') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER submissions_skip_blocked BEFORE INSERT ON submissions
  FOR EACH ROW EXECUTE FUNCTION submissions_skip_blocked();


-- R8：只能對待審中的詞投票、改票或收回。
-- FOR SHARE 鎖住審核紀錄：編輯要等這次投票結束才能做決定，不會「剛審完又被投一票」。
CREATE FUNCTION votes_only_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.word_id ELSE NEW.word_id END;
BEGIN
  PERFORM 1 FROM word_reviews WHERE word_id = w AND status = 'pending' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '只能對待審中的詞投票（word_id = %）', w USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER votes_only_pending BEFORE INSERT OR UPDATE OR DELETE ON votes
  FOR EACH ROW EXECUTE FUNCTION votes_only_pending();


-- ==================== 審核 ====================

-- R9：審核狀態只能這樣變
--   待審 → 加入／不收／封鎖
--   不收、封鎖 → 待審（重新審核）
--   加入 → 待審：只有詞條都還沒發布時（撤回，見 03_functions.sql）
-- 做決定的必須是編輯；row_version 每次修改加 1（樂觀鎖，R12）。
CREATE FUNCTION word_reviews_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION '新的審核紀錄必須是待審' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.word_id <> OLD.word_id THEN
    RAISE EXCEPTION '不能修改審核紀錄的詞' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'blocked'))
    OR (OLD.status IN ('rejected', 'blocked') AND NEW.status = 'pending')
    OR (OLD.status = 'approved' AND NEW.status = 'pending' AND NOT EXISTS (
          SELECT 1 FROM lexicon_entries
           WHERE word_id = NEW.word_id AND status IN ('active', 'retired')))
  ) THEN
    RAISE EXCEPTION '審核狀態不能從 % 變成 %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  PERFORM assert_editor(NEW.reviewer_id, '做審核決定的人');
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER word_reviews_check BEFORE INSERT OR UPDATE ON word_reviews
  FOR EACH ROW EXECUTE FUNCTION word_reviews_check();


-- ==================== 正式詞條 ====================

-- 詞條的一生：staged（在草稿版本裡）→ active（發布）→ retired（停用）
--  - 新增：原始詞庫匯入時直接 active、沒有修改者；其他新增一律 staged，由編輯建立
--  - 詞和讀音不能改（R13）：讀錯了要「停用舊的＋新增對的」，才會留在變更清單裡
--  - 只能刪除還沒發布的 staged 詞條（撤回）；發布過的只能停用
CREATE FUNCTION lexicon_entries_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'staged' THEN
      RAISE EXCEPTION '已發布的詞條不能刪除，只能停用（entry_id = %）', OLD.entry_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT ((NEW.status = 'staged' AND NEW.updated_by IS NOT NULL)
         OR (NEW.status = 'active' AND NEW.updated_by IS NULL)) THEN
      RAISE EXCEPTION '新詞條必須由編輯建立為 staged（原始詞庫匯入除外）' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.word_id <> OLD.word_id OR NEW.bopomofo <> OLD.bopomofo THEN
      RAISE EXCEPTION '不能修改詞條的詞或讀音；請停用後新增一筆' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'staged' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION '詞條狀態不能從 % 變成 %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    IF NEW.updated_at = OLD.updated_at THEN
      NEW.updated_at := now();
    END IF;
  END IF;

  -- 只在記下新的修改者時檢查。publish_release 套用變更時不換修改者；
  -- 如果每次更新都檢查，改過詞條的編輯後來被停權或刪除帳號，整個草稿版本就發布不了。
  -- 同一位編輯再改一次由 change_entry 檢查。
  IF TG_OP = 'INSERT' OR NEW.updated_by IS DISTINCT FROM OLD.updated_by THEN
    PERFORM assert_editor(NEW.updated_by, '修改詞條的人');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lexicon_entries_check BEFORE INSERT OR UPDATE OR DELETE ON lexicon_entries
  FOR EACH ROW EXECUTE FUNCTION lexicon_entries_check();


-- ==================== 版本 ====================

-- R15：版本依序建立、發布後不能改也不能刪；只能刪除空的草稿
CREATE FUNCTION releases_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM assert_editor(NEW.created_by, '建立版本的人');
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION '新版本必須是草稿' USING ERRCODE = 'check_violation';
    END IF;
    -- 用 version_key 比，'10.0' 才會大於 '9.0'
    IF EXISTS (SELECT 1 FROM releases WHERE version_key(version) >= version_key(NEW.version)) THEN
      RAISE EXCEPTION '版本號 % 必須大於現有的所有版本', NEW.version USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' THEN
    RAISE EXCEPTION '版本 % 已發布，不能修改或刪除', OLD.version USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM release_changes WHERE release_id = OLD.release_id) THEN
      RAISE EXCEPTION '只能刪除空的草稿版本；請先撤回裡面的變更' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.version <> OLD.version THEN
    RAISE EXCEPTION '不能修改版本號' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER releases_check BEFORE INSERT OR UPDATE OR DELETE ON releases
  FOR EACH ROW EXECUTE FUNCTION releases_check();


-- R11、R14、R15：變更清單只能寫進草稿版本，新詞不能超過名額。
-- 先鎖版本那一列（FOR UPDATE）再數名額：兩個交易同時搶最後一個名額時，
-- 後到的要等前一個提交，才會數到最新的數字，不會超賣。
CREATE FUNCTION release_changes_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r releases%ROWTYPE;
  e lexicon_entries%ROWTYPE;
  used integer;
BEGIN
  SELECT * INTO r FROM releases
   WHERE release_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.release_id ELSE NEW.release_id END
     FOR UPDATE;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION '版本 % 已發布，變更清單不能修改', r.version USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- 變更要跟詞條目前的狀態對得上
  SELECT * INTO e FROM lexicon_entries WHERE entry_id = NEW.entry_id FOR UPDATE;
  IF NEW.action = 'add' AND e.status <> 'staged' THEN
    RAISE EXCEPTION '只有 staged 詞條能「新增」' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action IN ('remove', 'reweight') THEN
    IF e.status <> 'active' THEN
      RAISE EXCEPTION '只有上線中的詞條能停用或調詞頻' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.old_frequency <> e.frequency THEN
      RAISE EXCEPTION '變更前詞頻 % 與詞條目前的 % 不符', NEW.old_frequency, e.frequency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 新詞名額
  IF NEW.action = 'add' AND (TG_OP = 'INSERT' OR OLD.action <> 'add') THEN
    SELECT count(*) INTO used FROM release_changes
     WHERE release_id = r.release_id AND action = 'add';
    IF used >= r.max_new_words THEN
      RAISE EXCEPTION '版本 % 的新詞名額已滿（%/%）', r.version, used, r.max_new_words
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER release_changes_check BEFORE INSERT OR UPDATE OR DELETE ON release_changes
  FOR EACH ROW EXECUTE FUNCTION release_changes_check();


-- ==================== 回報 ====================

-- R16：只能回報上線中的詞條；R17：只能從待處理變成已處理或駁回，處理者是編輯，處理完不能再改
CREATE FUNCTION reports_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION '新的回報必須是待處理' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM lexicon_entries WHERE entry_id = NEW.entry_id AND status = 'active') THEN
      RAISE EXCEPTION '只能回報上線中的詞條' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '回報 % 已處理，不能再修改', OLD.report_id USING ERRCODE = 'check_violation';
  END IF;
  PERFORM assert_editor(NEW.handler_id, '處理回報的人');
  RETURN NEW;
END $$;

CREATE TRIGGER reports_check BEFORE INSERT OR UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_check();


-- ==================== 個人詞與詞庫包 ====================

-- R19：個人詞刪除只做標記，其他裝置同步時才知道要刪掉
CREATE FUNCTION personal_words_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '個人詞不能真的刪除，請把 status 改成 deleted' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER personal_words_no_delete BEFORE DELETE ON personal_words
  FOR EACH ROW EXECUTE FUNCTION personal_words_no_delete();


-- 詞庫包由編輯建立；草稿 → 上架 ⇄ 下架，上架過就不能退回草稿或刪除
CREATE FUNCTION packs_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '只能刪除草稿詞庫包' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- 只在建立或換建立者時檢查：建立者離職後，其他編輯仍要能上架、下架
  IF TG_OP = 'INSERT' OR NEW.owner_id <> OLD.owner_id THEN
    PERFORM assert_editor(NEW.owner_id, '詞庫包的建立者');
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION '新詞庫包必須是草稿' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status = 'published')
    OR (OLD.status = 'published' AND NEW.status = 'archived')
    OR (OLD.status = 'archived'  AND NEW.status = 'published')) THEN
    RAISE EXCEPTION '詞庫包狀態不能從 % 變成 %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER packs_check BEFORE INSERT OR UPDATE OR DELETE ON packs
  FOR EACH ROW EXECUTE FUNCTION packs_check();


-- R21：詞庫包只能放上線中的詞條
CREATE FUNCTION pack_entries_only_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lexicon_entries WHERE entry_id = NEW.entry_id AND status = 'active') THEN
    RAISE EXCEPTION '詞庫包只能放上線中的詞條' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pack_entries_only_active BEFORE INSERT OR UPDATE ON pack_entries
  FOR EACH ROW EXECUTE FUNCTION pack_entries_only_active();


-- R20：只能訂閱上架中的詞庫包。
-- 只在「變成訂閱中」時檢查：新訂閱、重新訂閱都會擋；取消訂閱不受影響。
CREATE FUNCTION subscriptions_only_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active')
     AND NOT EXISTS (SELECT 1 FROM packs WHERE pack_id = NEW.pack_id AND status = 'published') THEN
    RAISE EXCEPTION '只能訂閱上架中的詞庫包' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER subscriptions_only_published BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_only_published();
