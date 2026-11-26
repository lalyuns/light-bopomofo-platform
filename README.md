# 輕注音詞庫共享平台

資料庫管理（115-1）期末專案・第 4 組：闕以諾、顧懷允、劉威廷、周緯倫

> 書面報告：（期末補上）・展示影片：（期末補上）

[輕注音](https://github.com/nvlznn/light-bopomofo)是一套「注音不用打完整」的輸入法：打 `ㄍㄌㄑ` 就能出現「國旅券」。前提是詞庫裡要有這個詞。新詞每天都在出現，只靠維護者一個人加詞追不上。

這個平台讓**使用者一起維護詞庫**：

1. 輸入法自動分享使用者打出、詞庫卻沒有的詞
2. 大家對這些新詞投票，也能回報詞庫裡的錯誤
3. 編輯審核後把新詞放進下一版詞庫，每版最多 200 個
4. 發布之後，所有人都打得到

資料庫有 PostgreSQL 16 張資料表（約 370 萬筆）與 MongoDB 3 個 collection（約 205 萬筆）。

## 安裝

只需要 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（macOS、Windows、Linux 都可以）。

```sh
git clone https://github.com/lalyuns/light-bopomofo-platform.git
cd light-bopomofo-platform
docker compose up -d --build
```

第一次啟動會從 `backup/` 自動還原兩個資料庫，**約需 2 到 5 分鐘**，指令會等到資料庫準備好才結束。完成後打開 http://localhost:3000。

會用到電腦上的連接埠 3000（網頁）、5433（PostgreSQL）、27018（MongoDB）。如果被其他程式占用，請改 `docker-compose.yml` 裡 `ports` 冒號左邊的數字。

### 示範帳號

密碼都是 `demo1234`。

| 帳號 | 角色 |
|---|---|
| `editor@lightbopomofo.test` | 編輯 |
| `editor3@lightbopomofo.test` | 編輯（搶名額示範用的第二位） |
| `user@lightbopomofo.test` | 一般使用者 |

## 五分鐘教學：讓「國旅券」打得出來

1. **查詢詞庫**：首字注音輸入 `ㄍㄌㄑ`，詞庫裡還沒有「國旅券」。
2. **待審新詞**：「國旅券」排第一，有 1,904 台裝置打過。用 `user@lightbopomofo.test` 登入，按 ▲ 投一票。
3. **審核台**：改用 `editor@lightbopomofo.test` 登入。草稿版本 9.0 的新詞名額是 **199/200**。點「國旅券」，系統會從使用者的打法建議讀音 `ㄍㄨㄛˊ ㄌㄩˇ ㄑㄩㄢˋ`，按「加入草稿版本」。
4. **兩人搶最後一個名額**：開一個無痕視窗，用 `editor3@lightbopomofo.test` 登入審核台。兩邊分別選「國旅券」和「普發」，同時按加入：只有一邊成功，另一邊收到「名額不夠（已用 200/200）」。
5. **版本**：看 9.0 的變更清單，可以撤回，或按「發布 9.0」。
6. **查詢詞庫**：再查一次 `ㄍㄌㄑ`，「國旅券」出現了。
7. **分析**：6 項營運分析，其中 3 項合併了 MongoDB 的選字紀錄與審核歷程。
8. **管理**：建立「台灣地名」之類的詞庫包、加入詞條、上架或下架；搜尋帳號，停權洗票帳號（他的票立刻不計入待審排序）。

一般使用者在「我的」裡還可以：沒裝輸入法也能用「分享新詞」投稿（算成這個帳號的「網頁」裝置），以及在「帳號」刪除自己的帳號（清空 email 與名稱，投票與回報紀錄保留但不再計入）。

輸入法分享新詞用的 API（格式與輕注音現有的相同）：

```sh
curl -X POST http://localhost:3000/api/words -H 'content-type: application/json' \
  -d '{"device":"11111111-2222-3333-4444-555555555555","app":"8.0",
       "words":[{"text":"國旅券","typed":"ㄍㄌㄑ","count":3}]}'
```

輸入法同步用的 API（裝置要先在「我的裝置」綁定帳號）：

| API | 用途 |
|---|---|
| `GET /api/devices/<uuid>/personal-words?since=<時間>` | 取回這個時間之後有變動的個人詞（含刪除標記） |
| `POST /api/devices/<uuid>/personal-words` | 上傳這台裝置新增或刪除的個人詞：`{"words":[{"text":"周緯倫","bopomofo":"ㄓㄡ ㄨㄟˇ ㄌㄨㄣˊ","status":"active"}]}` |
| `GET /api/devices/<uuid>/packs` | 下載訂閱中、上架中的詞庫包與它們的詞條 |

停權帳號的裝置不能同步（403）。帳號刪除後，裝置仍可取回刪除標記（回應帶 `account_deleted: true`）和空的詞庫包清單，但不能再上傳；這台裝置可以改綁到別的帳號。

### 把資料還原成初始狀態

教學會改到資料。以下兩行會刪掉資料庫，再從備份重新還原：

```sh
docker compose down -v
docker compose up -d --build
```

## 專案結構

| 路徑 | 內容 |
|---|---|
| `db/` | PostgreSQL：16 張資料表與索引、規則檢查（trigger）、交易函式、materialized view |
| `server/` | 後端：Node.js＋Express，JSON API |
| `public/` | 前端：一個網頁，登入後依角色顯示 8 個畫面 |
| `data/` | 資料匯入與生成腳本 |
| `backup/` | 兩個資料庫的備份（切成 45 MB 一份），第一次啟動時自動還原 |
| `docker/` | 資料庫第一次啟動時執行的還原腳本 |
| `tests/` | 冒煙測試（30 項規則）與併行測試 |
| `bench/` | 效能量測；結果在 `bench/results/` |

## 其他指令

```sh
bash tests/run.sh      # 在臨時資料庫上測試所有規則，跑完自動刪除
bash bench/run.sh      # 量測索引效果、待審列表三種寫法、100 個請求同時送出（跑完會還原資料）
bash data/import.sh    # 從原始資料重建整個資料庫（約 10 分鐘，需要 Python 3）
bash data/backup.sh    # 把目前的資料庫匯出到 backup/
```

## 資料來源與授權

| 資料 | 來源 | 授權 |
|---|---|---|
| 詞庫 16 萬筆 | [新酷音詞庫 tsi.csv](https://github.com/chewing/libchewing-data) | LGPL-2.1-or-later |
| 詞組 200 萬組 | 輕注音由 [FineWeb-2](https://huggingface.co/datasets/HuggingFaceFW/fineweb-2) 統計 | ODC-By 1.0 |
| 10 個版本與詞庫調整 | [輕注音](https://github.com/nvlznn/light-bopomofo) 的發布紀錄 | MIT |
| 候選新詞的詞與注音 | 教育部《重編國語辭典修訂本》，[g0v 整理版](https://github.com/g0v/moedict-data) | CC BY-ND 3.0 TW |
| 帳號、投稿、投票、審核、回報 | 依規則生成，見 `data/generate.py` | — |

程式碼採用 MIT 授權。
